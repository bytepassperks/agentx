import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config";
import type { Config } from "./config";

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown> & { required?: string[] };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StreamResult {
  content: ContentBlock[];
  stopReason: string;
  usage: Usage;
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onToolStart?: (name: string) => void;
}

interface SseEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; text?: string; input?: Record<string, unknown> };
  delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: Usage };
  usage?: Partial<Usage>;
  error?: { type: string; message: string };
}

export class LlmError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function streamMessage(
  cfg: Config,
  system: string,
  messages: Message[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    stream: true,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
  };

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": cfg.authToken,
        authorization: `Bearer ${cfg.authToken}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    const text = await res.text();
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    throw new LlmError(`API ${res.status}: ${text.slice(0, 500)}`, res.status);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    // Proxy did not stream; parse a full message.
    const json = (await res.json()) as { content: ContentBlock[]; stop_reason: string; usage: Usage };
    for (const b of json.content) if (b.type === "text") handlers.onText?.(b.text);
    return { content: json.content, stopReason: json.stop_reason, usage: json.usage };
  }

  const blocks: ContentBlock[] = [];
  const jsonBuf = new Map<number, string>();
  let stopReason = "end_turn";
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };

  const debugLog = process.env.AGENTX_DEBUG ? (s: string) => appendFileSync(join(CONFIG_DIR, "debug.log"), `${new Date().toISOString()} ${s}\n`) : null;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handle = (ev: SseEvent) => {
    switch (ev.type) {
      case "message_start":
        if (ev.message?.usage) usage = { ...usage, ...ev.message.usage };
        break;
      case "content_block_start": {
        const cb = ev.content_block!;
        if (cb.type === "text") blocks[ev.index!] = { type: "text", text: cb.text ?? "" };
        else if (cb.type === "tool_use") {
          const preset = cb.input && typeof cb.input === "object" && Object.keys(cb.input).length ? cb.input : {};
          blocks[ev.index!] = { type: "tool_use", id: cb.id!, name: cb.name!, input: preset };
          // Some proxies emit input_json_delta before content_block_start; keep whatever already arrived.
          if (!jsonBuf.has(ev.index!)) jsonBuf.set(ev.index!, "");
          handlers.onToolStart?.(cb.name!);
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta!;
        const b = blocks[ev.index!];
        if (d.type === "text_delta" && b?.type === "text") {
          const t = fixMojibake(d.text ?? "");
          b.text += t;
          handlers.onText?.(t);
        } else if (d.type === "input_json_delta") {
          jsonBuf.set(ev.index!, (jsonBuf.get(ev.index!) ?? "") + fixMojibake(d.partial_json ?? ""));
        }
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index!];
        if (b?.type === "tool_use") {
          const raw = jsonBuf.get(ev.index!) ?? "";
          if (raw.trim()) {
            try {
              b.input = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              b.input = { _raw: raw };
            }
          }
          if (debugLog) debugLog(`tool_use ${b.name} raw=${JSON.stringify(raw)} input=${JSON.stringify(b.input)}`);
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) usage = { ...usage, ...ev.usage };
        break;
      case "error":
        throw new LlmError(`stream error: ${ev.error?.message ?? "unknown"}`);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const l of chunk.split("\n")) {
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        if (debugLog) debugLog(data);
        handle(JSON.parse(data) as SseEvent);
      }
    }
  }
  for (const l of buf.split("\n")) {
    if (!l.startsWith("data:")) continue;
    const data = l.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      handle(JSON.parse(data) as SseEvent);
    } catch {}
  }

  return { content: blocks.filter(Boolean), stopReason, usage };
}

/** Some proxies emit UTF-8 bytes re-encoded as Latin-1 in streaming mode ("1â\u0080\u009315"); undo that. */
export function fixMojibake(s: string): string {
  if (!/[\u00C2-\u00F4][\u0080-\u00BF]/.test(s)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("\uFFFD") ? s : fixed;
}

/** Non-streaming helper for internal calls (summaries etc.). */
export async function complete(cfg: Config, system: string, prompt: string, maxTokens = 4096): Promise<string> {
  const r = await streamMessage(
    { ...cfg, maxTokens },
    system,
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [],
    {},
  );
  return r.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

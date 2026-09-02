import type { Config } from "./config";
import { LlmError, fixMojibake } from "./llm";
import type { ContentBlock, Message, StreamHandlers, StreamResult, ToolSpec, ToolUseBlock, Usage } from "./llm";

/** OpenAI-compatible chat/completions client (NVIDIA NIM, OpenRouter, Groq, ...) that speaks our Anthropic-style blocks. */

type OaiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toOai(system: string, messages: Message[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const calls: OaiToolCall[] = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      out.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      let text = "";
      for (const b of m.content) {
        if (b.type === "tool_result") {
          if (text) {
            out.push({ role: "user", content: text });
            text = "";
          }
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERROR: " : "") + b.content });
        } else if (b.type === "text") text += b.text;
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

function toolsToOai(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

function mapStop(r: string | null | undefined): string {
  if (r === "tool_calls" || r === "function_call") return "tool_use";
  if (r === "length") return "max_tokens";
  return "end_turn";
}

interface Chunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

export async function streamOpenAI(
  cfg: Config,
  system: string,
  messages: Message[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
  opts: { stream?: boolean } = {},
): Promise<StreamResult> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";
  const stream = opts.stream !== false;
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    stream,
    messages: toOai(system, messages),
  };
  if (tools.length) {
    body.tools = toolsToOai(tools);
    body.tool_choice = "auto";
  }
  if (stream) body.stream_options = { include_usage: true };

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", authorization: `Bearer ${cfg.authToken}` },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    const text = await res.text();
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    if (retryable && attempt < 8) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = ra > 0 ? Math.min(ra * 1000, 90_000) : Math.min(2000 * 2 ** attempt, 60_000);
      handlers.onWait?.(res.status, wait);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new LlmError(`API ${res.status}: ${text.slice(0, 500)}`, res.status);
  }

  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const applyUsage = (u: Chunk["usage"]) => {
    if (!u) return;
    if (u.prompt_tokens) usage.input_tokens = u.prompt_tokens;
    if (u.completion_tokens) usage.output_tokens = u.completion_tokens;
  };

  const ct = res.headers.get("content-type") ?? "";
  if (!stream || !ct.includes("text/event-stream")) {
    const json = (await res.json()) as {
      choices: { message: { content?: string | null; tool_calls?: OaiToolCall[] }; finish_reason?: string }[];
      usage?: Chunk["usage"];
    };
    const msg = json.choices?.[0]?.message ?? {};
    const content: ContentBlock[] = [];
    if (msg.content) {
      content.push({ type: "text", text: msg.content });
      handlers.onText?.(msg.content);
    }
    for (const c of msg.tool_calls ?? []) {
      handlers.onToolStart?.(c.function.name);
      content.push({ type: "tool_use", id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function.name, input: parseArgs(c.function.arguments) });
    }
    applyUsage(json.usage);
    return { content, stopReason: mapStop(json.choices?.[0]?.finish_reason), usage, complete: true };
  }

  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish: string | null | undefined;
  let complete = false;

  const handle = (c: Chunk) => {
    if (c.error) throw new LlmError(`stream error: ${typeof c.error === "string" ? c.error : c.error.message ?? "unknown"}`);
    applyUsage(c.usage);
    const ch = c.choices?.[0];
    if (!ch) return;
    if (ch.delta?.content) {
      const t = fixMojibake(ch.delta.content);
      text += t;
      handlers.onText?.(t);
    }
    for (const tc of ch.delta?.tool_calls ?? []) {
      let cur = calls.get(tc.index);
      if (!cur) {
        cur = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
        calls.set(tc.index, cur);
        if (cur.name) handlers.onToolStart?.(cur.name);
      } else {
        if (tc.id && !cur.id) cur.id = tc.id;
        if (tc.function?.name && !cur.name) {
          cur.name = tc.function.name;
          handlers.onToolStart?.(cur.name);
        }
      }
      if (tc.function?.arguments) cur.args += tc.function.arguments;
    }
    if (ch.finish_reason) {
      finish = ch.finish_reason;
      complete = true;
    }
  };

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const feed = (data: string) => {
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") complete = true;
      return;
    }
    handle(JSON.parse(data) as Chunk);
  };
  while (true) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch (e) {
      if (signal?.aborted) throw e;
      break;
    }
    if (step.done) break;
    buf += decoder.decode(step.value, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const l of chunk.split("\n")) if (l.startsWith("data:")) feed(l.slice(5).trim());
    }
  }
  for (const l of buf.split("\n")) {
    if (!l.startsWith("data:")) continue;
    try {
      feed(l.slice(5).trim());
    } catch {}
  }

  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({ type: "tool_use", id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, input: parseArgs(c.args) });
  }
  const stopReason = calls.size ? "tool_use" : mapStop(finish);
  return { content, stopReason, usage, complete };
}

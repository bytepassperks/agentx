import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clip, err, type TodoItem, type Tool } from "./types";

export const webFetch: Tool<{ url: string; max_chars?: number }> = {
  spec: {
    name: "web_fetch",
    description: "Fetch a URL and return its content as text (HTML is stripped to readable text; JSON returned as-is). Use for docs, APIs, and web pages.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, max_chars: { type: "number", description: "default 20000" } },
      required: ["url"],
    },
  },
  summarize: (i) => i.url,
  async run(i) {
    try {
      const res = await fetch(i.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; agentx/1.0)", accept: "text/html,application/json,text/plain,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      const ct = res.headers.get("content-type") ?? "";
      let text = await res.text();
      if (ct.includes("html")) text = htmlToText(text);
      return { output: `[${res.status} ${ct.split(";")[0]}]\n` + clip(text, i.max_chars ?? 20_000), isError: !res.ok };
    } catch (e) {
      return err(`fetch failed: ${(e as Error).message}`);
    }
  },
};

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|pre|blockquote)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const todoWrite: Tool<{ todos: TodoItem[] }> = {
  spec: {
    name: "todo_write",
    description:
      "Replace the task list for the current job. Use it to plan multi-step work and track progress (mark exactly one item in_progress at a time; mark completed immediately when done).",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  summarize: (i) => `${i.todos?.length ?? 0} items`,
  async run(i, ctx) {
    ctx.todos.splice(0, ctx.todos.length, ...i.todos);
    return { output: renderTodos(ctx.todos) };
  },
};

export function renderTodos(todos: TodoItem[]) {
  if (!todos.length) return "(no tasks)";
  const mark = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
  return todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n");
}

export const memorySave: Tool<{ scope: "project" | "global"; note: string }> = {
  spec: {
    name: "memory_save",
    description:
      "Persist a durable note for future sessions. scope=project (this repo: architecture, commands, conventions, gotchas) or global (user preferences that apply everywhere). Keep notes short and factual. They are shown to you at the start of every session.",
    input_schema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["project", "global"] }, note: { type: "string" } },
      required: ["scope", "note"],
    },
  },
  summarize: (i) => `${i.scope}: ${i.note}`,
  async run(i, ctx) {
    const p = i.scope === "global" ? ctx.globalMemoryPath : ctx.projectMemoryPath;
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, `# agentx memory (${i.scope})\n\n`);
    appendFileSync(p, `- ${i.note.trim().replace(/\n+/g, " ")}\n`);
    return { output: `saved to ${p}` };
  },
};

export function readMemory(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  } catch {
    return "";
  }
}

export const askUser: Tool<{ question: string }> = {
  spec: {
    name: "ask_user",
    description:
      "Ask the user a question and wait for their answer. Use only when truly blocked (missing credentials, ambiguous requirements with real consequences, destructive actions). Prefer making reasonable assumptions and continuing.",
    input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  summarize: (i) => i.question,
  async run(i, ctx) {
    const a = await ctx.askUser(i.question);
    return { output: a.trim() ? `User answered: ${a}` : "User gave no answer; proceed with your best judgment." };
  },
};

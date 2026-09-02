import type { ToolSpec } from "../llm";

export interface ToolContext {
  cwd: string;
  githubToken: string;
  askUser: (question: string) => Promise<string>;
  todos: TodoItem[];
  projectMemoryPath: string;
  globalMemoryPath: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface Tool<I = Record<string, unknown>> {
  spec: ToolSpec;
  summarize: (input: I) => string;
  run: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}

export const MAX_OUTPUT = 30_000;

export function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.25));
  return `${head}\n\n... [truncated ${s.length - max} chars] ...\n\n${tail}`;
}

export function err(msg: string): ToolResult {
  return { output: msg, isError: true };
}

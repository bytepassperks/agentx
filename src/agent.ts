import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { basename, join } from "node:path";
import { CONFIG_DIR, type Config } from "./config";
import { brokenToolUses, complete, LlmError, streamMessage, type ContentBlock, type Message, type TextBlock, type ToolResultBlock, type ToolUseBlock, type Usage } from "./llm";
import { toolByName, toolSpecs } from "./tools";
import { readMemory } from "./tools/misc";
import { runShell } from "./tools/shell";
import type { TodoItem, ToolContext } from "./tools/types";
import * as ui from "./ui";

export interface AgentEvents {
  thinking(label: string): void;
  textDelta(delta: string): void;
  textEnd(): void;
  toolStart(id: string, name: string, summary: string, input: Record<string, unknown>): void;
  toolEnd(id: string, output: string, isError: boolean, ms: number): void;
  todos(todos: TodoItem[]): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  done(): void;
}

/** Terminal renderer used by the CLI. */
export const cliEvents: AgentEvents = {
  thinking: (l) => ui.spinnerStart(l),
  textDelta: (d) => {
    ui.spinnerStop();
    ui.write(d);
  },
  textEnd: () => {
    ui.spinnerStop();
    ui.write("\n");
  },
  toolStart: (_id, name, summary) => {
    ui.spinnerStop();
    ui.toolHeader(name, summary);
  },
  toolEnd: (_id, output, isError, ms) => ui.toolResult(output + ui.color.gray(`  (${(ms / 1000).toFixed(1)}s)`), isError),
  todos: () => {},
  info: (t) => {
    ui.spinnerStop();
    ui.info(t);
  },
  warn: (t) => {
    ui.spinnerStop();
    ui.warn(t);
  },
  error: (t) => {
    ui.spinnerStop();
    ui.error(t);
  },
  done: () => ui.spinnerStop(),
};

export interface SessionFile {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messages: Message[];
  todos: TodoItem[];
}

export class Agent {
  messages: Message[] = [];
  todos: TodoItem[] = [];
  sessionId: string;
  projectDir: string;
  ctx: ToolContext;
  lastUsage: Usage | null = null;
  abort: AbortController | null = null;
  title = "";

  constructor(public cfg: Config, public cwd: string, askUser: (q: string) => Promise<string>, public ev: AgentEvents = cliEvents) {
    const hash = createHash("sha1").update(cwd.toLowerCase()).digest("hex").slice(0, 12);
    this.projectDir = join(CONFIG_DIR, "projects", hash);
    mkdirSync(join(this.projectDir, "sessions"), { recursive: true });
    this.sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    this.ctx = {
      cwd,
      githubToken: cfg.githubToken,
      askUser,
      todos: this.todos,
      projectMemoryPath: join(this.projectDir, "MEMORY.md"),
      globalMemoryPath: join(CONFIG_DIR, "MEMORY.md"),
    };
  }

  // ---------- sessions ----------
  listSessions(): SessionFile[] {
    const dir = join(this.projectDir, "sessions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionFile;
        } catch {
          return null;
        }
      })
      .filter((s): s is SessionFile => !!s)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  resume(s: SessionFile) {
    this.sessionId = s.id;
    this.messages = s.messages;
    this.todos.splice(0, this.todos.length, ...(s.todos ?? []));
    this.title = s.title;
  }

  save() {
    if (!this.messages.length) return;
    const s: SessionFile = {
      id: this.sessionId,
      cwd: this.cwd,
      createdAt: this.sessionId,
      updatedAt: new Date().toISOString(),
      title: this.title,
      messages: this.messages,
      todos: this.todos,
    };
    writeFileSync(join(this.projectDir, "sessions", `${this.sessionId}.json`), JSON.stringify(s));
  }

  // ---------- prompt ----------
  async systemPrompt(): Promise<string> {
    const isWin = process.platform === "win32";
    const git = await this.gitContext();
    const projectMem = readMemory(this.ctx.projectMemoryPath);
    const globalMem = readMemory(this.ctx.globalMemoryPath);
    const repoDocs = ["AGENTX.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"]
      .map((f) => join(this.cwd, f))
      .filter(existsSync)
      .map((f) => `## ${basename(f)}\n${readFileSync(f, "utf8").slice(0, 8000)}`)
      .join("\n\n");

    return `You are agentx, an autonomous software engineering agent (like Devin) running directly on the user's ${isWin ? "Windows" : platform()} machine with full access to their shell, filesystem, git and GitHub.

# Environment
- OS: ${platform()} ${release()} (${isWin ? "PowerShell commands" : "bash commands"}), host ${hostname()}
- Working directory: ${this.cwd}
- Date: ${new Date().toDateString()}
${git}

# How you work
- Be autonomous: understand the request, explore the code (list_dir, glob, grep, read_file), plan with todo_write for multi-step work, implement, then VERIFY by actually running builds/tests/lint via shell. Don't stop at the first error; fix it. Keep going until the task is truly done.
- Read before you write: always read a file before editing it. Prefer edit_file for targeted changes; write_file for new files.
- Follow existing conventions in the repo. Minimal, focused changes. No unnecessary comments or refactors.
- Git: work on a feature branch when changing an existing repo unless told otherwise, write clear commit messages, use git_push to push and github create_pr to open PRs when asked or when it clearly fits the workflow. Never force-push main. Never run destructive commands (rm -rf outside the project, git reset --hard, etc.) without asking.
- Never wait on interactive commands. Never leak secrets into files or logs.
- Use ask_user only when truly blocked. Otherwise make sensible assumptions and state them.
- Use memory_save to remember durable facts about this project (build/test commands, structure, gotchas) and user preferences, so future sessions start smarter.
- Communicate tersely. When done, give a short summary of what changed, how you verified it, and anything the user must do.
${isWin ? `- Windows tips: paths use backslashes but forward slashes also work; use PowerShell syntax (\`;\` to chain, \`$env:VAR\`, \`Get-ChildItem\`, \`Select-String\`). Quote paths with spaces. \`npm\`, \`npx\`, \`python\`, \`git\` are usually on PATH.\n` : ""}
${globalMem ? `# Global memory\n${globalMem}\n` : ""}
${projectMem ? `# Project memory\n${projectMem}\n` : ""}
${repoDocs ? `# Repository instructions\n${repoDocs}\n` : ""}
${this.todos.length ? `# Current task list\n${this.todos.map((t) => `- [${t.status}] ${t.content}`).join("\n")}\n` : ""}`;
  }

  async gitContext(): Promise<string> {
    const r = await runShell("git rev-parse --is-inside-work-tree", this.cwd, 10_000).catch(() => null);
    if (!r || r.code !== 0) return "- Git: not a git repository";
    const [branch, status, remote, log] = await Promise.all([
      runShell("git rev-parse --abbrev-ref HEAD", this.cwd, 10_000),
      runShell("git status --short", this.cwd, 10_000),
      runShell("git remote get-url origin", this.cwd, 10_000),
      runShell("git log --oneline -n 5", this.cwd, 10_000),
    ]);
    const st = status.stdout.trim();
    return `- Git branch: ${branch.stdout.trim()} | remote: ${remote.stdout.trim() || "none"}
- Git status: ${st ? `\n${st.split("\n").slice(0, 30).join("\n")}` : "clean"}
- Recent commits:\n${log.stdout.trim()}`;
  }

  // ---------- main loop ----------
  async run(userInput: string): Promise<void> {
    if (!this.title) this.title = userInput.slice(0, 80);
    this.messages.push({ role: "user", content: [{ type: "text", text: userInput }] });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    try {
      for (let turn = 0; turn < this.cfg.maxTurns; turn++) {
        if (signal.aborted) break;
        await this.maybeCompact();
        const system = await this.systemPrompt();

        this.ev.thinking("thinking");
        let started = false;
        let result = await streamMessage(this.cfg, system, this.messages, toolSpecs, {
          onText: (d) => {
            if (!started) {
              started = true;
              this.ev.textDelta("\n");
            }
            this.ev.textDelta(d);
          },
          onToolStart: () => {
            if (started) {
              started = false;
              this.ev.textEnd();
            }
            this.ev.thinking("preparing tool call");
          },
        }, signal);
        if (started) this.ev.textEnd();
        let truncated = !result.complete || brokenToolUses(result.content, toolSpecs).length > 0;
        if (truncated && !signal.aborted) {
          this.ev.warn("connection to the API was cut mid-response; re-requesting this turn without streaming");
          this.ev.thinking("thinking (non-streaming)");
          try {
            const again = await streamMessage(this.cfg, system, this.messages, toolSpecs, {}, signal, { stream: false });
            if (!brokenToolUses(again.content, toolSpecs).length) {
              for (const b of again.content) if (b.type === "text" && b.text) this.ev.textDelta(b.text);
              this.ev.textEnd();
              result = again;
              truncated = false;
            }
          } catch (e) {
            if (signal.aborted) throw e;
            this.ev.warn(`retry failed: ${(e as Error).message}`);
          }
        }
        if (truncated) {
          // Keep whatever text arrived, drop half-formed tool calls, and ask the model to continue.
          const text = result.content.filter((b): b is TextBlock => b.type === "text" && !!b.text);
          this.messages.push({ role: "assistant", content: text.length ? text : [{ type: "text", text: "(response lost)" }] });
          this.messages.push({ role: "user", content: [{ type: "text", text: "[system] Your previous response was cut off by a network error. Continue exactly where you stopped (re-issue any tool calls you were about to make)." }] });
          this.save();
          continue;
        }
        this.lastUsage = result.usage;

        if (!result.content.length) result.content.push({ type: "text", text: "" });
        this.messages.push({ role: "assistant", content: result.content });
        this.save();

        const toolUses = result.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (!toolUses.length || result.stopReason === "end_turn" && !toolUses.length) break;

        const results: ToolResultBlock[] = [];
        for (const tu of toolUses) {
          if (signal.aborted) {
            results.push({ type: "tool_result", tool_use_id: tu.id, content: "[cancelled by user]", is_error: true });
            continue;
          }
          results.push(await this.execTool(tu));
        }
        this.messages.push({ role: "user", content: results });
        this.save();
        if (signal.aborted) break;

        if (result.stopReason === "max_tokens") {
          this.messages.push({ role: "user", content: [{ type: "text", text: "[system] Output was cut off at max_tokens. Continue where you left off." }] });
        }
      }
    } catch (e) {
      if (signal.aborted) {
        this.ev.warn("interrupted");
        this.messages.push({ role: "user", content: [{ type: "text", text: "[system] The user interrupted. Wait for their next instruction." }] });
        this.repairTrailing();
      } else if (e instanceof LlmError) {
        this.ev.error(e.message);
        this.repairTrailing();
      } else {
        this.ev.error((e as Error).message);
        this.repairTrailing();
      }
    } finally {
      this.abort = null;
      this.save();
      this.ev.done();
    }
  }

  /** Make sure history never ends with an unanswered tool_use (API rejects that). */
  private repairTrailing() {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "assistant") {
      const uses = last.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (uses.length) {
        this.messages.push({
          role: "user",
          content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "[not executed]", is_error: true }) as ToolResultBlock),
        });
      }
    }
    // Collapse consecutive user messages.
    const out: Message[] = [];
    for (const m of this.messages) {
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) prev.content.push(...m.content);
      else out.push({ role: m.role, content: [...m.content] });
    }
    this.messages = out;
  }

  private async execTool(tu: ToolUseBlock): Promise<ToolResultBlock> {
    const tool = toolByName.get(tu.name);
    if (!tool) return { type: "tool_result", tool_use_id: tu.id, content: `unknown tool ${tu.name}`, is_error: true };
    let summary = "";
    try {
      summary = tool.summarize(tu.input);
    } catch {}
    this.ev.toolStart(tu.id, tu.name, summary, tu.input);
    const t0 = Date.now();
    const missing = (tool.spec.input_schema.required ?? []).filter((k) => tu.input[k] === undefined);
    if (missing.length) {
      const msg = `invalid call: missing required argument(s) ${missing.join(", ")} (got ${JSON.stringify(tu.input)}). Call ${tu.name} again with the full arguments.`;
      this.ev.toolEnd(tu.id, msg, true, 0);
      return { type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true };
    }
    try {
      const r = await tool.run(tu.input, this.ctx);
      this.ev.toolEnd(tu.id, r.output, !!r.isError, Date.now() - t0);
      if (tu.name === "todo_write") this.ev.todos([...this.todos]);
      return { type: "tool_result", tool_use_id: tu.id, content: r.output || "(no output)", is_error: r.isError };
    } catch (e) {
      const msg = `tool crashed: ${(e as Error).stack ?? e}`;
      this.ev.toolEnd(tu.id, msg, true, Date.now() - t0);
      return { type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true };
    }
  }

  // ---------- context management ----------
  estimateTokens(): number {
    if (this.lastUsage) {
      return (this.lastUsage.input_tokens ?? 0) + (this.lastUsage.cache_read_input_tokens ?? 0) + (this.lastUsage.cache_creation_input_tokens ?? 0) + (this.lastUsage.output_tokens ?? 0);
    }
    return Math.ceil(JSON.stringify(this.messages).length / 3.5);
  }

  async maybeCompact() {
    if (this.estimateTokens() > this.cfg.compactThresholdTokens && this.messages.length > 4) {
      this.ev.info(`context ~${Math.round(this.estimateTokens() / 1000)}k tokens; compacting...`);
      await this.compact();
    }
  }

  async compact(extraInstructions = ""): Promise<void> {
    if (this.messages.length < 2) return;
    const transcript = this.messages
      .map((m) => {
        const parts = m.content.map((b: ContentBlock) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") return `[tool_use ${b.name}] ${JSON.stringify(b.input).slice(0, 800)}`;
          return `[tool_result${b.is_error ? " ERROR" : ""}] ${b.content.slice(0, 1200)}`;
        });
        return `${m.role.toUpperCase()}:\n${parts.join("\n")}`;
      })
      .join("\n\n");

    this.ev.thinking("compacting context");
    let summary: string;
    try {
      summary = await complete(
        this.cfg,
        "You compress an AI coding agent's conversation into a dense handoff document so the agent can continue seamlessly with no other memory. Be specific: file paths, commands, decisions, errors seen, what is done, what remains. Preserve any user requirements verbatim. Use markdown sections: Task & requirements; Progress so far (done); Key findings (files/architecture/commands); Open problems; Next steps. Under 2000 words.",
        `${extraInstructions ? `Extra focus: ${extraInstructions}\n\n` : ""}CONVERSATION:\n\n${transcript.slice(-400_000)}`,
        6000,
      );
    } finally {
      this.ev.done();
    }

    this.messages = [
      { role: "user", content: [{ type: "text", text: `[Context was compacted. Summary of the conversation so far:]\n\n${summary}` }] },
      { role: "assistant", content: [{ type: "text", text: "Understood. I have the full context from the summary and will continue from the next steps." }] },
    ];
    this.lastUsage = null;
    this.save();
    this.ev.info("context compacted");
  }

  lastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role !== "assistant") continue;
      return m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
    }
    return "";
  }
}

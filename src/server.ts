import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Agent, type AgentEvents } from "./agent";
import { inferProvider, loadConfig, PRESETS, saveConfig, type Config } from "./config";
import { listModels, type ContentBlock, type Message } from "./llm";
import { toolByName } from "./tools";
import { runShell } from "./tools/shell";
import htmlSrc from "./web/index.html" with { type: "text" };
const html = htmlSrc as unknown as string;

type Client = { send(data: string): void };

interface Pending {
  resolve: (a: string) => void;
}

export class GuiServer {
  agent: Agent | null = null;
  clients = new Set<Client>();
  pendingAsk: Pending | null = null;
  cfg: Config;
  cwd: string;
  version: string;

  constructor(version: string, initialCwd: string) {
    this.version = version;
    this.cfg = loadConfig();
    this.cwd = initialCwd;
  }

  broadcast(msg: Record<string, unknown>) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) {
      try {
        c.send(s);
      } catch {}
    }
  }

  events(): AgentEvents {
    return {
      thinking: (label) => this.broadcast({ type: "thinking", label }),
      textDelta: (delta) => this.broadcast({ type: "text_delta", delta }),
      textEnd: () => this.broadcast({ type: "text_end" }),
      toolStart: (id, name, summary, input) => this.broadcast({ type: "tool_start", id, name, summary, input }),
      toolEnd: (id, output, isError, ms) => this.broadcast({ type: "tool_end", id, output, isError, ms }),
      todos: (todos) => this.broadcast({ type: "todos", todos }),
      info: (text) => this.broadcast({ type: "info", text }),
      warn: (text) => this.broadcast({ type: "warn", text }),
      error: (text) => this.broadcast({ type: "error", text }),
      done: () => this.broadcast({ type: "done" }),
    };
  }

  ensureAgent(): Agent {
    if (!this.agent) {
      this.agent = new Agent(this.cfg, this.cwd, (q) => this.ask(q), this.events());
    }
    return this.agent;
  }

  ask(question: string): Promise<string> {
    this.broadcast({ type: "ask", question });
    return new Promise((resolve) => {
      this.pendingAsk = { resolve };
    });
  }

  state() {
    const a = this.ensureAgent();
    return {
      type: "state",
      version: this.version,
      cwd: this.cwd,
      busy: !!a.abort,
      model: this.cfg.model,
      sessionId: a.sessionId,
      title: a.title,
      todos: a.todos,
      messages: a.messages.map(renderMessage).filter(Boolean),
      sessions: a.listSessions().slice(0, 30).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, count: s.messages.length })),
      config: { ...this.cfg, authToken: mask(this.cfg.authToken), githubToken: mask(this.cfg.githubToken) },
      hasToken: !!this.cfg.authToken,
      presets: PRESETS,
      home: homedir(),
    };
  }

  async handle(c: Client, raw: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const a = this.ensureAgent();
    switch (m.type) {
      case "hello":
        c.send(JSON.stringify(this.state()));
        break;
      case "user": {
        const text = String(m.text ?? "").trim();
        if (!text) return;
        if (this.pendingAsk) {
          const p = this.pendingAsk;
          this.pendingAsk = null;
          p.resolve(text);
          return;
        }
        if (a.abort) {
          this.broadcast({ type: "warn", text: "Agent is busy; wait or press Stop." });
          return;
        }
        this.broadcast({ type: "user", text });
        void a.run(text).then(() => this.broadcast(this.state()));
        break;
      }
      case "abort":
        if (this.pendingAsk) {
          const p = this.pendingAsk;
          this.pendingAsk = null;
          p.resolve("");
        }
        a.abort?.abort();
        break;
      case "compact":
        if (a.abort) return;
        await a.compact();
        this.broadcast(this.state());
        break;
      case "new":
        if (a.abort) a.abort.abort();
        a.save();
        this.agent = new Agent(this.cfg, this.cwd, (q) => this.ask(q), this.events());
        this.broadcast(this.state());
        break;
      case "resume": {
        const s = a.listSessions().find((x) => x.id === m.id);
        if (!s) return;
        a.save();
        this.agent = new Agent(this.cfg, this.cwd, (q) => this.ask(q), this.events());
        this.agent.resume(s);
        this.broadcast(this.state());
        break;
      }
      case "set_cwd": {
        const p = resolve(String(m.cwd ?? ""));
        if (!existsSync(p) || !statSync(p).isDirectory()) {
          c.send(JSON.stringify({ type: "error", text: `Folder not found: ${p}` }));
          return;
        }
        if (a.abort) a.abort.abort();
        a.save();
        this.cwd = p;
        try {
          process.chdir(p);
        } catch {}
        this.agent = new Agent(this.cfg, this.cwd, (q) => this.ask(q), this.events());
        this.broadcast(this.state());
        break;
      }
      case "pick_folder": {
        const picked = await pickFolder(this.cwd);
        if (picked) await this.handle(c, JSON.stringify({ type: "set_cwd", cwd: picked }));
        break;
      }
      case "list_dir": {
        const p = resolve(String(m.path ?? this.cwd));
        c.send(JSON.stringify({ type: "dir", path: p, parent: dirname(p), entries: listDirs(p) }));
        break;
      }
      case "set_config": {
        const patch = (m.patch ?? {}) as Partial<Config>;
        // don't overwrite secrets with masked values
        if (patch.authToken && patch.authToken.includes("…")) delete patch.authToken;
        if (patch.githubToken && patch.githubToken.includes("…")) delete patch.githubToken;
        if (patch.baseUrl && !patch.provider) patch.provider = inferProvider(patch.baseUrl);
        this.cfg = saveConfig(patch);
        a.cfg = this.cfg;
        a.ctx.githubToken = this.cfg.githubToken;
        this.broadcast(this.state());
        this.broadcast({ type: "info", text: "Settings saved" });
        break;
      }
      case "list_models": {
        const probe: Config = { ...this.cfg, ...((m.patch ?? {}) as Partial<Config>) };
        if (!probe.authToken || probe.authToken.includes("…")) probe.authToken = this.cfg.authToken;
        if (probe.baseUrl !== this.cfg.baseUrl) probe.provider = inferProvider(probe.baseUrl);
        try {
          c.send(JSON.stringify({ type: "models", models: await listModels(probe) }));
        } catch (e) {
          c.send(JSON.stringify({ type: "models", models: [], error: (e as Error).message }));
        }
        break;
      }
      case "shell": {
        const r = await runShell(String(m.command ?? ""), this.cwd, 300_000);
        c.send(JSON.stringify({ type: "shell_result", output: r.stdout + (r.stderr ? "\n" + r.stderr : "") + `\n[exit ${r.code}]` }));
        break;
      }
      case "open_path": {
        const p = String(m.path ?? this.cwd);
        const cmd = process.platform === "win32" ? `Start-Process "${p}"` : process.platform === "darwin" ? `open "${p}"` : `xdg-open "${p}"`;
        void runShell(cmd, this.cwd, 10_000);
        break;
      }
    }
  }

  start(port = 0) {
    const server = Bun.serve<{ id: number }>({
      hostname: "127.0.0.1",
      port,
      fetch: (req, srv) => {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          if (srv.upgrade(req, { data: { id: Date.now() } })) return undefined as unknown as Response;
          return new Response("upgrade failed", { status: 400 });
        }
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (url.pathname === "/health") return new Response("ok");
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws);
        },
        message: (ws, msg) => {
          void this.handle(ws, typeof msg === "string" ? msg : new TextDecoder().decode(msg));
        },
        close: (ws) => {
          this.clients.delete(ws);
        },
      },
    });
    return server;
  }
}

function mask(s: string) {
  return s ? s.slice(0, 4) + "…" + s.slice(-3) : "";
}

function listDirs(p: string) {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500);
  } catch {
    return [];
  }
}

export function renderMessage(m: Message) {
  const parts: Record<string, unknown>[] = [];
  for (const b of m.content as ContentBlock[]) {
    if (b.type === "text") {
      if (b.text.trim()) parts.push({ kind: "text", text: b.text });
    } else if (b.type === "tool_use") {
      let summary = "";
      try {
        summary = toolByName.get(b.name)?.summarize(b.input) ?? "";
      } catch {}
      parts.push({ kind: "tool_use", id: b.id, name: b.name, summary, input: b.input });
    } else if (b.type === "tool_result") {
      parts.push({ kind: "tool_result", id: b.tool_use_id, output: b.content, isError: !!b.is_error });
    }
  }
  if (!parts.length) return null;
  return { role: m.role, parts };
}

/** Native folder picker (Windows: WinForms dialog; macOS: osascript; Linux: zenity). Returns null if unavailable/cancelled. */
export async function pickFolder(start: string): Promise<string | null> {
  let cmd: string;
  if (process.platform === "win32") {
    cmd = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the project folder for agentx'; $d.SelectedPath = '${start.replace(/'/g, "''")}'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})) -eq 'OK') { Write-Output $d.SelectedPath }`;
  } else if (process.platform === "darwin") {
    cmd = `osascript -e 'POSIX path of (choose folder with prompt "Choose the project folder")' 2>/dev/null`;
  } else {
    cmd = `zenity --file-selection --directory --title="Choose the project folder" 2>/dev/null`;
  }
  const r = await runShell(cmd, start, 300_000).catch(() => null);
  const out = r?.stdout.trim();
  if (!out) return null;
  const p = out.split(/\r?\n/).pop()!.trim().replace(/\/$/, "");
  return existsSync(p) ? join(p) : null;
}

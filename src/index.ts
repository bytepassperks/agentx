import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { Agent } from "./agent";
import { CONFIG_PATH, loadConfig, saveConfig, type Config } from "./config";
import { launchGui } from "./gui";
import { renderTodos } from "./tools/misc";
import { runShell } from "./tools/shell";
import * as ui from "./ui";

export const VERSION = "0.2.3";
const INSTALL_URL = "https://raw.githubusercontent.com/bytepassperks/agentx/main/install.ps1";

function usage() {
  ui.line(`agentx v${VERSION} — autonomous coding agent

Usage:
  agentx                       open the desktop app (GUI) for the current directory
  agentx --cli                 interactive terminal session in the current directory
  agentx --serve [--port N]    run the GUI server without opening a window
  agentx "do something"        run one task in the terminal, print result, exit
  agentx -c                    continue the most recent session in this directory
  agentx config [--token T] [--base-url U] [--model M] [--github-token G] [--show]
  agentx update                re-run the installer to get the latest version
  agentx --version

Inside a session:
  /help /compact /clear /resume /tasks /model <m> /config /memory /cwd <dir> /exit
  !<command>                   run a shell command directly`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  if (argv[0] === "--version" || argv[0] === "-v") return ui.line(VERSION);
  if (argv[0] === "--help" || argv[0] === "-h") return usage();

  if (argv[0] === "config") {
    const patch: Partial<Config> = {};
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      const v = argv[i + 1];
      if (a === "--token" && v) (patch.authToken = v), i++;
      else if (a === "--base-url" && v) (patch.baseUrl = v), i++;
      else if (a === "--model" && v) (patch.model = v), i++;
      else if (a === "--github-token" && v) (patch.githubToken = v), i++;
      else if (a === "--max-tokens" && v) (patch.maxTokens = Number(v)), i++;
    }
    if (Object.keys(patch).length) saveConfig(patch);
    const cfg = loadConfig();
    ui.line(`config file: ${CONFIG_PATH}`);
    ui.line(JSON.stringify({ ...cfg, authToken: mask(cfg.authToken), githubToken: mask(cfg.githubToken) }, null, 2));
    return;
  }

  if (argv[0] === "update") {
    if (process.platform !== "win32") return ui.error("update is only supported on Windows; re-run the installer manually.");
    ui.info("downloading latest version...");
    const r = await runShell(`$env:AGENTX_NO_LAUNCH="1"; irm "${INSTALL_URL}?$(Get-Random)" | iex`, cwd, 300_000);
    ui.line(r.stdout + r.stderr);
    return;
  }

  const continueLast = argv.includes("-c") || argv.includes("--continue");
  const cli = argv.includes("--cli");
  const serve = argv.includes("--serve");
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : undefined;
  const task = argv.filter((a, i) => !a.startsWith("-") && !(portIdx >= 0 && i === portIdx + 1)).join(" ").trim();

  if (!cli && !task && !continueLast) {
    await launchGui(VERSION, cwd, { port, open: !serve });
    return;
  }

  const cfg = loadConfig();
  if (!cfg.authToken) {
    ui.error(`no API token configured. Run: agentx config --token <token> --base-url <url>`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) =>
    new Promise<string>((res) => {
      ui.line();
      rl.question(ui.color.yellow(`  ? ${q}\n`) + ui.color.bold("  > "), (a) => res(a));
    });

  const agent = new Agent(cfg, cwd, ask);

  if (continueLast) {
    const last = agent.listSessions()[0];
    if (last) {
      agent.resume(last);
      ui.info(`resumed session "${last.title}" (${last.messages.length} messages)`);
    }
  }

  // One-shot mode
  if (task) {
    await agent.run(task);
    rl.close();
    return;
  }

  ui.banner(VERSION, cfg.model, cwd);

  let sigints = 0;
  process.on("SIGINT", () => {
    if (agent.abort) {
      agent.abort.abort();
      sigints = 0;
      return;
    }
    sigints++;
    if (sigints >= 2) {
      ui.line();
      process.exit(0);
    }
    ui.line(ui.color.gray("\n  (press Ctrl+C again to exit)"));
    prompt();
  });

  const prompt = () => {
    rl.setPrompt(ui.color.bold(ui.color.magenta(process.platform === "win32" ? "\n> " : "\n❯ ")));
    rl.prompt();
  };

  const queue: string[] = [];
  let busy = false;
  let closed = false;

  const handle = async (input: string) => {
    if (input.startsWith("/")) await slash(input, agent, rl);
    else if (input.startsWith("!")) {
      const r = await runShell(input.slice(1), agent.cwd, 300_000);
      ui.line(r.stdout + (r.stderr ? ui.color.red(r.stderr) : ""));
    } else await agent.run(input);
  };

  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const input = queue.shift()!;
      try {
        await handle(input);
      } catch (e) {
        ui.error((e as Error).stack ?? String(e));
      }
    }
    busy = false;
    if (closed) {
      agent.save();
      ui.line();
      process.exit(0);
    }
    prompt();
  };

  rl.on("line", (raw) => {
    const input = raw.trim();
    sigints = 0;
    if (!input) return busy ? undefined : prompt();
    queue.push(input);
    if (busy) ui.info("(queued — will run after the current task)");
    void drain();
  });

  rl.on("close", () => {
    closed = true;
    if (!busy) {
      agent.save();
      ui.line();
      process.exit(0);
    }
  });

  prompt();
}

async function slash(input: string, agent: Agent, rl: readline.Interface) {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/help":
      usage();
      break;
    case "/exit":
    case "/quit":
      rl.close();
      break;
    case "/compact":
      await agent.compact(arg);
      break;
    case "/clear":
    case "/new":
      agent.save();
      agent.messages = [];
      agent.todos.splice(0);
      agent.title = "";
      agent.sessionId = new Date().toISOString().replace(/[:.]/g, "-");
      ui.info("started a new session");
      break;
    case "/resume": {
      const sessions = agent.listSessions();
      if (!sessions.length) return ui.info("no saved sessions for this directory");
      if (arg) {
        const s = sessions[Number(arg) - 1];
        if (!s) return ui.error("no such session");
        agent.resume(s);
        return ui.info(`resumed "${s.title}"`);
      }
      sessions.slice(0, 15).forEach((s, i) => ui.line(ui.color.gray(`  ${i + 1}. ${s.updatedAt.slice(0, 16)}  ${s.title}  (${s.messages.length} msgs)`)));
      ui.info("use /resume <n>");
      break;
    }
    case "/tasks":
    case "/todos":
      ui.line(renderTodos(agent.todos));
      break;
    case "/model":
      if (!arg) return ui.info(`model: ${agent.cfg.model}`);
      agent.cfg = saveConfig({ model: arg });
      ui.info(`model set to ${arg}`);
      break;
    case "/config":
      ui.line(JSON.stringify({ ...agent.cfg, authToken: mask(agent.cfg.authToken), githubToken: mask(agent.cfg.githubToken) }, null, 2));
      break;
    case "/memory":
      ui.line(ui.color.gray(`  project: ${agent.ctx.projectMemoryPath}\n  global:  ${agent.ctx.globalMemoryPath}`));
      break;
    case "/cwd": {
      if (!arg) return ui.info(agent.cwd);
      const p = resolve(agent.cwd, arg);
      if (!existsSync(p)) return ui.error(`not found: ${p}`);
      process.chdir(p);
      agent.cwd = p;
      agent.ctx.cwd = p;
      ui.info(`cwd: ${p}`);
      break;
    }
    case "/usage":
      ui.info(`~${Math.round(agent.estimateTokens() / 1000)}k tokens in context, ${agent.messages.length} messages`);
      break;
    default:
      ui.warn(`unknown command ${cmd}; /help`);
  }
}

function mask(s: string) {
  return s ? s.slice(0, 4) + "…" + s.slice(-3) : "";
}

main().catch((e) => {
  ui.error((e as Error).stack ?? String(e));
  process.exit(1);
});

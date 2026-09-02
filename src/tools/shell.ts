import { isAbsolute, resolve } from "node:path";
import { clip, err, type Tool } from "./types";

const IS_WIN = process.platform === "win32";

interface In {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export function shellArgs(command: string): string[] {
  if (IS_WIN) {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; ${command}`,
    ];
  }
  return ["bash", "-lc", command];
}

export async function runShell(command: string, cwd: string, timeoutMs: number) {
  const proc = Bun.spawn(shellArgs(command), {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "1", NO_COLOR: "1" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, code, timedOut };
}

export const shell: Tool<In> = {
  spec: {
    name: "shell",
    description: IS_WIN
      ? "Run a PowerShell command on the user's Windows machine and return stdout/stderr/exit code. Use for git, npm, python, builds, tests, installs, listing files, etc. Non-interactive: never run commands that wait for input. Long-running servers: start them with Start-Process or in the background and check logs."
      : "Run a bash command and return stdout/stderr/exit code. Use for git, npm, python, builds, tests, installs, etc. Non-interactive: never run commands that wait for input. Long-running servers: run in background with & and redirect logs.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        cwd: { type: "string", description: "Working directory (default: project cwd)." },
        timeout_ms: { type: "number", description: "Timeout in ms (default 120000, max 600000)." },
      },
      required: ["command"],
    },
  },
  summarize: (i) => i.command,
  async run(i, ctx) {
    const cwd = i.cwd ? (isAbsolute(i.cwd) ? i.cwd : resolve(ctx.cwd, i.cwd)) : ctx.cwd;
    const timeout = Math.min(Math.max(i.timeout_ms ?? 120_000, 1000), 600_000);
    try {
      const r = await runShell(i.command, cwd, timeout);
      let out = "";
      if (r.stdout.trim()) out += r.stdout;
      if (r.stderr.trim()) out += (out ? "\n" : "") + "[stderr]\n" + r.stderr;
      if (r.timedOut) out += `\n[timed out after ${timeout}ms]`;
      out += `\n[exit code ${r.code}]`;
      return { output: clip(out), isError: r.code !== 0 || r.timedOut };
    } catch (e) {
      return err(`failed to spawn shell: ${(e as Error).message}`);
    }
  },
};

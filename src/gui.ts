import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config";
import { GuiServer } from "./server";
import { runShell } from "./tools/shell";
import * as ui from "./ui";

function findBrowser(): string | null {
  const env = process.env;
  const candidates =
    process.platform === "win32"
      ? [
          join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
          join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
          join(env.ProgramFiles ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          join(env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          join(env.ProgramFiles ?? "C:\\Program Files", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser"];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

export async function launchGui(version: string, cwd: string, opts: { port?: number; open?: boolean }) {
  const gs = new GuiServer(version, cwd);
  const server = gs.start(opts.port ?? 0);
  const url = `http://127.0.0.1:${server.port}/`;
  ui.line(ui.color.gray(`  agentx v${version} GUI at ${url}`));

  if (opts.open === false) return;

  const browser = findBrowser();
  if (browser) {
    const proc = Bun.spawn(
      [
        browser,
        `--app=${url}`,
        `--user-data-dir=${join(CONFIG_DIR, "webview")}`,
        "--window-size=1280,860",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,TranslateUI",
        "--disable-sync",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    // Exit when the app window closes (the dedicated profile makes this process the window).
    proc.exited.then(() => {
      gs.agent?.save();
      // small grace period in case it was a relaunch handshake
      setTimeout(() => process.exit(0), 500);
    });
    return;
  }

  const cmd = process.platform === "win32" ? `Start-Process "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  await runShell(cmd, cwd, 10_000).catch(() => null);
  ui.line(ui.color.gray("  (no Chromium browser found for app mode; opened in the default browser — keep this window open)"));
}

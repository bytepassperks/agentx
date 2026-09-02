const isTTY = process.stdout.isTTY ?? false;
const c = (code: string) => (s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  dim: c("2"),
  bold: c("1"),
  red: c("31"),
  green: c("32"),
  yellow: c("33"),
  blue: c("34"),
  magenta: c("35"),
  cyan: c("36"),
  gray: c("90"),
};

export function write(s: string) {
  process.stdout.write(s);
}

export function line(s = "") {
  process.stdout.write(s + "\n");
}

export function info(s: string) {
  line(color.gray(`  ${s}`));
}

export function warn(s: string) {
  line(color.yellow(`  ! ${s}`));
}

export function error(s: string) {
  line(color.red(`  x ${s}`));
}

export function toolHeader(name: string, summary: string) {
  line(color.cyan(`  > ${name}`) + color.gray(` ${truncate(summary, 160)}`));
}

export function toolResult(text: string, isError: boolean) {
  const lines = text.split("\n");
  const shown = lines.slice(0, 12);
  for (const l of shown) line((isError ? color.red : color.gray)(`    ${truncate(l, 200)}`));
  if (lines.length > shown.length) line(color.gray(`    ... (${lines.length - shown.length} more lines)`));
}

export function truncate(s: string, n: number) {
  s = s.replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

export function banner(version: string, model: string, cwd: string) {
  line();
  line(color.bold(color.magenta("  agentx")) + color.gray(` v${version}  ·  ${model}`));
  line(color.gray(`  cwd: ${cwd}`));
  line(color.gray("  /help for commands · Ctrl+C twice to quit"));
  line();
}

let spinnerTimer: ReturnType<typeof setInterval> | null = null;
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerStart(label: string) {
  if (!isTTY) return;
  let i = 0;
  spinnerStop();
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${color.magenta(frames[i++ % frames.length]!)} ${color.gray(label)}   `);
  }, 80);
}

export function spinnerStop() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    process.stdout.write("\r\x1b[2K");
  }
}

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { clip, err, type Tool, type ToolContext } from "./types";

export const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", "target", "__pycache__", ".venv", "venv",
  ".cache", ".turbo", "coverage", ".idea", ".vs", "bin", "obj", ".agentx",
]);

export function abs(p: string, ctx: ToolContext) {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

export const readFile: Tool<{ path: string; offset?: number; limit?: number }> = {
  spec: {
    name: "read_file",
    description:
      "Read a text file. Returns numbered lines. Use offset/limit for large files (default first 2000 lines).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based start line" },
        limit: { type: "number", description: "max lines" },
      },
      required: ["path"],
    },
  },
  summarize: (i) => i.path,
  async run(i, ctx) {
    const p = abs(i.path, ctx);
    if (!existsSync(p)) return err(`not found: ${p}`);
    const st = statSync(p);
    if (st.isDirectory()) return err(`${p} is a directory; use list_dir`);
    if (st.size > 5_000_000) return err(`file too large (${st.size} bytes)`);
    const text = readFileSync(p, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, i.offset ?? 1);
    const limit = i.limit ?? 2000;
    const slice = lines.slice(start - 1, start - 1 + limit);
    const width = String(start + slice.length).length;
    const out = slice.map((l, k) => `${String(start + k).padStart(width)}\t${l.length > 2000 ? l.slice(0, 2000) + "..." : l}`).join("\n");
    const more = lines.length > start - 1 + slice.length ? `\n[${lines.length - (start - 1 + slice.length)} more lines]` : "";
    return { output: clip(out + more, 60_000) };
  },
};

export const writeFile: Tool<{ path: string; content: string }> = {
  spec: {
    name: "write_file",
    description: "Create or overwrite a file with the given content (creates parent directories).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  summarize: (i) => `${i.path} (${i.content?.length ?? 0} chars)`,
  async run(i, ctx) {
    const p = abs(i.path, ctx);
    mkdirSync(dirname(p), { recursive: true });
    const existed = existsSync(p);
    writeFileSync(p, i.content);
    return { output: `${existed ? "overwrote" : "created"} ${p} (${i.content.split("\n").length} lines)` };
  },
};

export const editFile: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  spec: {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match exactly once (include enough context) unless replace_all is true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  summarize: (i) => i.path,
  async run(i, ctx) {
    const p = abs(i.path, ctx);
    if (!existsSync(p)) return err(`not found: ${p}`);
    const text = readFileSync(p, "utf8");
    if (i.old_string === i.new_string) return err("old_string and new_string are identical");
    const count = text.split(i.old_string).length - 1;
    if (count === 0) {
      // tolerate CRLF vs LF mismatch
      const alt = i.old_string.replace(/\r\n/g, "\n");
      const crlf = text.replace(/\r\n/g, "\n");
      const c2 = crlf.split(alt).length - 1;
      if (c2 === 1 || (c2 > 1 && i.replace_all)) {
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const next = crlf.split(alt).join(i.new_string.replace(/\r\n/g, "\n")).replace(/\n/g, eol);
        writeFileSync(p, next);
        return { output: `edited ${p} (${c2} replacement${c2 > 1 ? "s" : ""})` };
      }
      return err("old_string not found in file. Read the file and copy the exact text.");
    }
    if (count > 1 && !i.replace_all) return err(`old_string matches ${count} times; add more context or set replace_all`);
    writeFileSync(p, text.split(i.old_string).join(i.new_string));
    return { output: `edited ${p} (${count} replacement${count > 1 ? "s" : ""})` };
  },
};

export const listDir: Tool<{ path?: string; depth?: number }> = {
  spec: {
    name: "list_dir",
    description: "List files and directories as a tree (ignores node_modules, .git, build outputs).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, depth: { type: "number", description: "default 2" } },
    },
  },
  summarize: (i) => i.path ?? ".",
  async run(i, ctx) {
    const root = abs(i.path ?? ".", ctx);
    if (!existsSync(root)) return err(`not found: ${root}`);
    const depth = i.depth ?? 2;
    const lines: string[] = [];
    let count = 0;
    const walk = (dir: string, d: number, prefix: string) => {
      if (d > depth || count > 2000) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        count++;
        if (e.isDirectory()) {
          lines.push(`${prefix}${e.name}/${IGNORE_DIRS.has(e.name) ? " (ignored)" : ""}`);
          if (!IGNORE_DIRS.has(e.name)) walk(join(dir, e.name), d + 1, prefix + "  ");
        } else lines.push(`${prefix}${e.name}`);
      }
    };
    walk(root, 1, "");
    return { output: clip(`${root}\n` + lines.join("\n")) };
  },
};

export const glob: Tool<{ pattern: string; path?: string }> = {
  spec: {
    name: "glob",
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.test.js". Returns relative paths.',
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
  summarize: (i) => i.pattern,
  async run(i, ctx) {
    const root = abs(i.path ?? ".", ctx);
    const g = new Bun.Glob(i.pattern);
    const out: string[] = [];
    for await (const f of g.scan({ cwd: root, dot: false, onlyFiles: true })) {
      if (f.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg))) continue;
      out.push(f);
      if (out.length >= 1000) break;
    }
    out.sort();
    return { output: out.length ? clip(out.join("\n")) : "no matches" };
  },
};

export const grep: Tool<{ pattern: string; path?: string; glob?: string; case_insensitive?: boolean; context?: number }> = {
  spec: {
    name: "grep",
    description: "Search file contents with a regular expression (JavaScript regex). Returns file:line: text.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "directory or file" },
        glob: { type: "string", description: 'restrict to files matching e.g. "*.ts"' },
        case_insensitive: { type: "boolean" },
        context: { type: "number", description: "lines of context" },
      },
      required: ["pattern"],
    },
  },
  summarize: (i) => `/${i.pattern}/ ${i.path ?? ""} ${i.glob ?? ""}`,
  async run(i, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(i.pattern, i.case_insensitive ? "i" : "");
    } catch (e) {
      return err(`bad regex: ${(e as Error).message}`);
    }
    const root = abs(i.path ?? ".", ctx);
    if (!existsSync(root)) return err(`not found: ${root}`);
    const fileGlob = i.glob ? new Bun.Glob(i.glob) : null;
    const results: string[] = [];
    let matches = 0;
    const files: string[] = [];
    if (statSync(root).isFile()) files.push(root);
    else {
      const walk = (dir: string) => {
        if (files.length > 20_000) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.isDirectory()) {
            if (!IGNORE_DIRS.has(e.name)) walk(join(dir, e.name));
          } else if (!fileGlob || fileGlob.match(e.name)) files.push(join(dir, e.name));
        }
      };
      walk(root);
    }
    for (const f of files) {
      if (matches >= 500) break;
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      if (st.size > 2_000_000) continue;
      const buf = readFileSync(f);
      if (buf.subarray(0, 1024).includes(0)) continue; // binary
      const lines = buf.toString("utf8").split(/\r?\n/);
      const rel = relative(ctx.cwd, f) || f;
      for (let n = 0; n < lines.length; n++) {
        if (!re.test(lines[n]!)) continue;
        matches++;
        const ctxN = i.context ?? 0;
        const lo = Math.max(0, n - ctxN);
        const hi = Math.min(lines.length - 1, n + ctxN);
        for (let k = lo; k <= hi; k++) results.push(`${rel}:${k + 1}${k === n ? ":" : "-"} ${lines[k]!.slice(0, 300)}`);
        if (ctxN) results.push("--");
        if (matches >= 500) break;
      }
    }
    return { output: results.length ? clip(results.join("\n")) : "no matches" };
  },
};

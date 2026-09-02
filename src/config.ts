import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  authToken: string;
  model: string;
  maxTokens: number;
  githubToken: string;
  gitUserName: string;
  gitUserEmail: string;
  autoApprove: boolean;
  maxTurns: number;
  compactThresholdTokens: number;
}

export const DEFAULTS: Config = {
  baseUrl: "https://claudemax-v4.pages.dev",
  authToken: "",
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  githubToken: "",
  gitUserName: "",
  gitUserEmail: "",
  autoApprove: true,
  maxTurns: 200,
  compactThresholdTokens: 120_000,
};

export const CONFIG_DIR = join(homedir(), ".agentx");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Fallback: reuse Claude Code's ~/.claude/settings.json env block if present. */
function claudeSettings(): Partial<Config> {
  const s = readJson(join(homedir(), ".claude", "settings.json"));
  const env = (s?.env ?? {}) as Record<string, string>;
  const out: Partial<Config> = {};
  if (env.ANTHROPIC_AUTH_TOKEN) out.authToken = env.ANTHROPIC_AUTH_TOKEN;
  if (env.ANTHROPIC_BASE_URL) out.baseUrl = env.ANTHROPIC_BASE_URL;
  return out;
}

export function loadConfig(): Config {
  const file = (readJson(CONFIG_PATH) ?? {}) as Partial<Config>;
  const env: Partial<Config> = {};
  if (process.env.ANTHROPIC_AUTH_TOKEN) env.authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_BASE_URL) env.baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (process.env.AGENTX_MODEL) env.model = process.env.AGENTX_MODEL;
  if (process.env.GITHUB_TOKEN) env.githubToken = process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) env.githubToken = process.env.GH_TOKEN;
  return { ...DEFAULTS, ...claudeSettings(), ...file, ...env };
}

export function saveConfig(patch: Partial<Config>): Config {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const current = (readJson(CONFIG_PATH) ?? {}) as Partial<Config>;
  const next = { ...current, ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return { ...DEFAULTS, ...next };
}

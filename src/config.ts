import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "anthropic" | "openai";

export interface ProviderPreset {
  id: string;
  label: string;
  provider: Provider;
  baseUrl: string;
  keyUrl: string;
  /** suggested models; the live list comes from GET /v1/models */
  models: string[];
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "nvidia",
    label: "NVIDIA (free, build.nvidia.com)",
    provider: "openai",
    baseUrl: "https://integrate.api.nvidia.com",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    // ordered fast→slow as measured on the free tier; all verified to emit tool calls
    models: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "deepseek-ai/deepseek-v4-pro-0813",
      "deepseek-ai/deepseek-v4-flash-0731",
      "moonshotai/kimi-k3",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "openai",
    baseUrl: "https://openrouter.ai/api",
    keyUrl: "https://openrouter.ai/settings/keys",
    models: [],
  },
  {
    id: "groq",
    label: "Groq (free tier)",
    provider: "openai",
    baseUrl: "https://api.groq.com/openai",
    keyUrl: "https://console.groq.com/keys",
    models: [],
  },
  {
    id: "anthropic",
    label: "Anthropic (or Anthropic-compatible proxy)",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  },
];

export interface Config {
  provider: Provider;
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
  provider: "openai",
  baseUrl: "https://integrate.api.nvidia.com",
  authToken: "",
  model: "nvidia/nemotron-3-super-120b-a12b",
  maxTokens: 8192,
  githubToken: "",
  gitUserName: "",
  gitUserEmail: "",
  autoApprove: true,
  maxTurns: 200,
  compactThresholdTokens: 100_000,
};

export const CONFIG_DIR = join(homedir(), ".agentx");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function loadConfig(): Config {
  const file = (readJson(CONFIG_PATH) ?? {}) as Partial<Config>;
  const env: Partial<Config> = {};
  if (process.env.AGENTX_TOKEN) env.authToken = process.env.AGENTX_TOKEN;
  if (process.env.AGENTX_BASE_URL) env.baseUrl = process.env.AGENTX_BASE_URL;
  if (process.env.AGENTX_MODEL) env.model = process.env.AGENTX_MODEL;
  if (process.env.AGENTX_GITHUB_TOKEN) env.githubToken = process.env.AGENTX_GITHUB_TOKEN;
  if (process.env.AGENTX_PROVIDER === "anthropic" || process.env.AGENTX_PROVIDER === "openai") env.provider = process.env.AGENTX_PROVIDER;
  const cfg = { ...DEFAULTS, ...file, ...env };
  // configs written before providers existed: infer from the URL
  if (!file.provider && !env.provider && file.baseUrl) cfg.provider = inferProvider(file.baseUrl);
  return cfg;
}

export function inferProvider(baseUrl: string): Provider {
  const p = PRESETS.find((x) => baseUrl.replace(/\/+$/, "").startsWith(x.baseUrl));
  if (p) return p.provider;
  return /anthropic|claude/i.test(baseUrl) ? "anthropic" : "openai";
}

export function saveConfig(patch: Partial<Config>): Config {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const current = (readJson(CONFIG_PATH) ?? {}) as Partial<Config>;
  const next = { ...current, ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return { ...DEFAULTS, ...next };
}

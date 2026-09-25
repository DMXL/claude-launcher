import { spawnSync } from "node:child_process";
import type { ModelConfig, ProviderConfig } from "./config.ts";

const ONE_MILLION = 1024 * 1024;
const COMPACT_FRACTION = 0.75;

export interface LaunchRequest {
  provider: ProviderConfig;
  model: ModelConfig;
  key: string;
  safe: boolean;
  forwarded: string[];
  env?: NodeJS.ProcessEnv;
}

export interface LaunchPlan {
  args: string[];
  env: NodeJS.ProcessEnv;
  settings: Record<string, unknown>;
}

export interface LaunchResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

// Claude Code assumes a 200k window for any model it does not know, and the [1m]
// suffix is the only client-side hint that says otherwise.
export function pickerId(model: ModelConfig): string {
  return model.context !== undefined && model.context >= ONE_MILLION ? `${model.id}[1m]` : model.id;
}

export function buildSettings(provider: ProviderConfig): Record<string, unknown> {
  const options = provider.models.map((model) => ({
    model: pickerId(model),
    label: model.label ?? model.id,
    ...(model.behavesAs !== undefined && { behavesAs: model.behavesAs }),
    ...(model.description !== undefined && { description: model.description }),
  }));

  return {
    disableClaudeAiConnectors: true,
    modelPicker: { replaceBuiltInOptions: true, options },
    ...provider.settings,
  };
}

export function buildEnv(request: LaunchRequest): NodeJS.ProcessEnv {
  const { provider, model, key } = request;
  const fast = provider.models.find((candidate) => candidate.id === provider.fastModel) ?? model;

  const environment: NodeJS.ProcessEnv = {
    ...(request.env ?? process.env),
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: pickerId(model),
    ANTHROPIC_DEFAULT_OPUS_MODEL: pickerId(model),
    ANTHROPIC_DEFAULT_SONNET_MODEL: pickerId(model),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: pickerId(fast),
    CLAUDE_CODE_SUBAGENT_MODEL: pickerId(fast),
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: pickerId(fast),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };

  if (model.context !== undefined) {
    environment.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.floor(model.context * COMPACT_FRACTION));
  }

  return environment;
}

export function planLaunch(request: LaunchRequest): LaunchPlan {
  const settings = buildSettings(request.provider);
  const args = ["--settings", JSON.stringify(settings)];

  if (!request.safe) {
    args.push("--allow-dangerously-skip-permissions");
  }

  args.push(...request.forwarded);

  return { args, env: buildEnv(request), settings };
}

export function runClaude(args: string[], env: NodeJS.ProcessEnv): LaunchResult {
  const result = spawnSync("claude", args, { stdio: "inherit", env });

  return {
    status: result.status,
    signal: result.signal,
    ...(result.error !== undefined && { error: result.error }),
  };
}

export function exitCode(result: LaunchResult): number {
  if (result.status !== null) return result.status;
  return result.signal === "SIGINT" ? 130 : 1;
}

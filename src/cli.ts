import { existsSync, readFileSync } from "node:fs";
import { runAdd } from "./add.ts";
import { BUILT_IN_PROVIDERS } from "./builtins.ts";
import {
  ConfigError,
  RESERVED_PROVIDER_NAMES,
  configPath,
  displayPath,
  loadConfig,
  shortenPath,
} from "./config.ts";
import { KeyError, envVarName, resolveKey } from "./key.ts";
import { exitCode, planLaunch, runClaude } from "./launch.ts";
import { fail, say } from "./output.ts";
import { didYouMean } from "./suggest.ts";

const USAGE = `claude-launcher: run Claude Code against any model.

Usage:
  claude-launcher <provider> [options] [claude options...]
  claude-launcher add <provider> [--force]
  claude-launcher list

Providers are declared in ~/.config/claude-launcher/config.toml. The
first positional names the provider to launch, so it may not be one of
the reserved commands: ${RESERVED_PROVIDER_NAMES.join(", ")}.

Options:
  --model <id>   Model for the session. Must be one this provider lists.
  --safe         Leave out --allow-dangerously-skip-permissions.
  -h, --help     Show this message.
  -v, --version  Show the version.

Anything else reaches claude untouched, and -- sends the rest through
without being read here at all.`;

interface LaunchArgs {
  model?: string;
  safe: boolean;
  forwarded: string[];
}

class UsageError extends Error {}

function readVersion(): string {
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(pkg) as { version: string }).version;
}

function splitArgs(argv: string[]): LaunchArgs {
  const forwarded: string[] = [];
  let model: string | undefined;
  let safe = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;

    if (argument === "--") {
      forwarded.push(...argv.slice(index + 1));
      break;
    }

    if (argument === "--safe") {
      safe = true;
      continue;
    }

    if (argument === "--model" || argument.startsWith("--model=")) {
      const value = argument === "--model" ? argv[index + 1] : argument.slice("--model=".length);
      if (value === undefined || value === "") {
        throw new UsageError("--model needs a model id");
      }
      model = value;
      if (argument === "--model") index++;
      continue;
    }

    forwarded.push(argument);
  }

  return { ...(model !== undefined && { model }), safe, forwarded };
}

function runProvider(argv: string[]): number {
  const providerName = argv[0]!;

  let request: LaunchArgs;
  try {
    request = splitArgs(argv.slice(1));
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message);
    throw error;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }

  const provider = config.providers.get(providerName);
  if (provider === undefined) {
    const known = [...config.providers.keys()];
    const detail =
      known.length === 0
        ? `no providers are configured in ${displayPath(config)}`
        : `configured providers: ${known.join(", ")}`;
    return fail(`unknown provider "${providerName}"${didYouMean(providerName, known)}\n  ${detail}`);
  }

  const modelId = request.model ?? provider.defaultModel;
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    const known = provider.models.map((candidate) => candidate.id);
    return fail(
      `unknown model "${modelId}" for ${providerName}${didYouMean(modelId, known)}\n  models: ${known.join(", ")}`,
    );
  }

  let key: string;
  try {
    key = resolveKey(providerName, provider).key;
  } catch (error) {
    if (error instanceof KeyError) return fail(error.message);
    throw error;
  }

  const plan = planLaunch({
    provider,
    model,
    key,
    safe: request.safe,
    forwarded: request.forwarded,
  });

  const result = runClaude(plan.args, plan.env);
  if (result.error !== undefined) {
    return fail(`could not run claude: ${result.error.message}`);
  }

  return exitCode(result);
}

function addUsage(): string {
  const shipped = [...BUILT_IN_PROVIDERS].map(([name, provider]) => `  ${name.padEnd(12)}${provider.baseUrl}`);
  return [
    "add a provider. shipped:",
    ...shipped,
    "",
    "usage: claude-launcher add <provider> [--force]",
    "",
    "--force replaces an existing stanza for that provider in place.",
  ].join("\n");
}

async function runAddCommand(argv: string[]): Promise<number> {
  let force = false;
  const names: string[] = [];

  for (const argument of argv) {
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      say(addUsage());
      return 0;
    }
    if (argument.startsWith("-")) {
      return fail(`add does not take "${argument}"`);
    }
    names.push(argument);
  }

  if (names.length === 0) {
    say(addUsage());
    return 1;
  }
  if (names.length > 1) {
    return fail("add takes one provider name");
  }

  return runAdd(names[0]!, { force });
}

function describeKey(name: string, provider: { key?: { command?: string; value?: string } }): string {
  if (provider.key?.command !== undefined) return `key from ${provider.key.command}`;
  if (provider.key?.value !== undefined) return "key from config.toml";
  return `key from ${envVarName(name)} or a prompt`;
}

function runList(): number {
  const env = process.env;
  const path = configPath(env);
  const lines = ["shipped", ...[...BUILT_IN_PROVIDERS.keys()].map((name) => `  ${name}`), ""];

  if (!existsSync(path)) {
    lines.push(`configured  none, no file at ${shortenPath(path, env)}`);
    say(lines.join("\n"));
    return 0;
  }

  let config;
  try {
    config = loadConfig({ env });
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }

  lines.push(`configured  ${displayPath(config, env)}`);
  if (config.providers.size === 0) {
    lines.push("  none");
  } else {
    for (const [name, provider] of config.providers) {
      const yours = BUILT_IN_PROVIDERS.has(name) ? "" : "   yours";
      lines.push(`  ${name.padEnd(12)}${describeKey(name, provider)}${yours}`);
    }
  }

  say(lines.join("\n"));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const [first] = argv;
  if (first === "-h" || first === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (first === "-v" || first === "--version") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  if (first === "add") return runAddCommand(argv.slice(1));
  if (first === "list") return runList();

  return runProvider(argv);
}

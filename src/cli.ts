import { readFileSync } from "node:fs";
import { ConfigError, RESERVED_PROVIDER_NAMES, displayPath, loadConfig } from "./config.ts";
import { KeyError, resolveKey } from "./key.ts";
import { exitCode, planLaunch, runClaude } from "./launch.ts";
import { didYouMean } from "./suggest.ts";

const USAGE = `claude-launcher: run Claude Code against any model.

Usage:
  claude-launcher <provider> [options] [claude options...]

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

function fail(message: string): number {
  process.stderr.write(`claude-launcher: ${message}\n`);
  return 1;
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

export function main(argv: string[]): number {
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

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, RESERVED_PROVIDER_NAMES, displayPath, loadConfig } from "./config.ts";
import { didYouMean } from "./suggest.ts";

const USAGE = `claude-launcher: run Claude Code against any model.

Usage:
  claude-launcher <provider> [options] [-- claude options]

Providers are declared in ~/.config/claude-launcher/config.toml. The
first positional names the provider to launch, so it may not be one of
the reserved commands: ${RESERVED_PROVIDER_NAMES.join(", ")}.

Options:
  -h, --help     Show this message.
  -v, --version  Show the version.

Providers load, but nothing is wired to Claude Code yet.`;

function readVersion(): string {
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(pkg) as { version: string }).version;
}

function fail(message: string): number {
  process.stderr.write(`claude-launcher: ${message}\n`);
  return 1;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help === true || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (values.version === true) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const [provider] = positionals;
  if (provider === undefined) {
    return fail("no provider given");
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return fail(error.message);
    }
    throw error;
  }

  const selected = config.providers.get(provider);
  if (selected === undefined) {
    const known = [...config.providers.keys()];
    const detail =
      known.length === 0
        ? `no providers are configured in ${displayPath(config)}`
        : `configured providers: ${known.join(", ")}`;
    return fail(`unknown provider "${provider}"${didYouMean(provider, known)}\n  ${detail}`);
  }

  return fail(
    `"${provider}" is configured (default model ${selected.defaultModel}), but launching is not implemented yet`,
  );
}

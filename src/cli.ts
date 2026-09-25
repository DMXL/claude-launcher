import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const RESERVED_COMMANDS = ["add", "list", "doctor", "config"] as const;

const USAGE = `claude-launcher: run Claude Code against any model.

Usage:
  claude-launcher <provider> [options] [-- claude options]

Providers are declared in ~/.config/claude-launcher/config.toml. The
first positional names the provider to launch, so it may not be one of
the reserved commands: ${RESERVED_COMMANDS.join(", ")}.

Options:
  -h, --help     Show this message.
  -v, --version  Show the version.

No provider is wired up yet.`;

function readVersion(): string {
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(pkg) as { version: string }).version;
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
  process.stderr.write(
    provider === undefined
      ? "claude-launcher: no provider given\n"
      : `claude-launcher: provider "${provider}" is not implemented yet\n`,
  );
  return 1;
}

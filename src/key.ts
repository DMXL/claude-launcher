import { spawnSync } from "node:child_process";
import type { ProviderConfig } from "./config.ts";
import { Interrupted, promptHidden } from "./prompt.ts";

export type KeySource = "environment" | "command" | "value" | "prompt";

export interface ResolvedKey {
  key: string;
  source: KeySource;
  detail: string;
}

export interface CommandOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (command: string) => CommandOutcome;
export type Prompt = (providerName: string) => string;

export interface ResolveKeyOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  runCommand?: CommandRunner;
  prompt?: Prompt;
}

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

export function envVarName(providerName: string): string {
  return `CLAUDE_LAUNCHER_${providerName.toUpperCase().replace(/-/g, "_")}_KEY`;
}

export const runKeyCommand: CommandRunner = (command) => {
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error !== undefined && { error: result.error }),
  };
};

export const promptForKey: Prompt = (providerName) => promptHidden(`Key for ${providerName}: `);

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

function missingKeyMessage(providerName: string, variable: string): string {
  return [
    `no key for ${providerName}. Provide one of:`,
    `  set ${variable}`,
    `  key = { command = "pass show ..." } in config.toml`,
    `  key = { value = "..." } in config.toml`,
  ].join("\n");
}

export function resolveKey(
  providerName: string,
  provider: ProviderConfig,
  options: ResolveKeyOptions = {},
): ResolvedKey {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runKeyCommand;
  const prompt = options.prompt ?? promptForKey;
  const isTTY = options.isTTY ?? process.stdin.isTTY === true;

  const variable = envVarName(providerName);
  const fromEnvironment = env[variable];
  if (fromEnvironment !== undefined) {
    const trimmed = fromEnvironment.trim();
    if (trimmed === "") {
      throw new KeyError(`${variable} is set but empty`);
    }
    return { key: trimmed, source: "environment", detail: variable };
  }

  const command = provider.key?.command;
  if (command !== undefined) {
    const outcome = runCommand(command);
    if (outcome.error !== undefined) {
      throw new KeyError(`key.command for ${providerName} could not start: ${outcome.error.message}`);
    }
    if (outcome.signal !== null) {
      throw new KeyError(`key.command for ${providerName} was killed by ${outcome.signal}`);
    }
    if (outcome.status !== 0) {
      const reason = firstLine(outcome.stderr);
      throw new KeyError(
        `key.command for ${providerName} exited ${outcome.status}${reason === "" ? "" : `: ${reason}`}`,
      );
    }

    const output = outcome.stdout.trim();
    if (output === "") {
      throw new KeyError(`key.command for ${providerName} printed nothing`);
    }
    return { key: output, source: "command", detail: command };
  }

  const literal = provider.key?.value;
  if (literal !== undefined) {
    return { key: literal.trim(), source: "value", detail: "key.value in config.toml" };
  }

  if (!isTTY) {
    throw new KeyError(missingKeyMessage(providerName, variable));
  }

  let typed: string;
  try {
    typed = prompt(providerName).trim();
  } catch (error) {
    if (error instanceof Interrupted) throw new KeyError("cancelled");
    throw error;
  }

  if (typed === "") {
    throw new KeyError(`no key entered for ${providerName}`);
  }
  return { key: typed, source: "prompt", detail: "typed at the prompt" };
}

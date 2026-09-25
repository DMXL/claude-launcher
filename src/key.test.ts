import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderConfig } from "./config.ts";
import {
  type CommandOutcome,
  type CommandRunner,
  KeyError,
  envVarName,
  resolveKey,
  runKeyCommand,
} from "./key.ts";

function provider(key?: ProviderConfig["key"]): ProviderConfig {
  return {
    baseUrl: "https://example.test/anthropic",
    models: [{ id: "a" }],
    defaultModel: "a",
    fastModel: "a",
    ...(key !== undefined && { key }),
  };
}

function runner(outcome: Partial<CommandOutcome>): CommandRunner {
  return () => ({ status: 0, signal: null, stdout: "", stderr: "", ...outcome });
}

function run(options: {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  runner?: CommandRunner;
  prompt?: (name: string) => string;
  config?: ProviderConfig;
}) {
  return resolveKey("deepseek", options.config ?? provider(), {
    env: options.env ?? {},
    isTTY: options.isTTY ?? false,
    runCommand: options.runner ?? runner({}),
    prompt: options.prompt ?? (() => ""),
  });
}

function failure(options: Parameters<typeof run>[0]): string {
  try {
    run(options);
  } catch (error) {
    if (error instanceof KeyError) return error.message;
    throw error;
  }
  return assert.fail("expected a KeyError");
}

describe("envVarName", () => {
  it("upper cases the provider and turns hyphens into underscores", () => {
    assert.equal(envVarName("deepseek"), "CLAUDE_LAUNCHER_DEEPSEEK_KEY");
    assert.equal(envVarName("xiaomi-mimo"), "CLAUDE_LAUNCHER_XIAOMI_MIMO_KEY");
  });
});

describe("resolveKey, environment", () => {
  it("reads the namespaced variable", () => {
    const resolved = run({ env: { CLAUDE_LAUNCHER_DEEPSEEK_KEY: "sk-env" } });
    assert.equal(resolved.key, "sk-env");
    assert.equal(resolved.source, "environment");
    assert.equal(resolved.detail, "CLAUDE_LAUNCHER_DEEPSEEK_KEY");
  });

  it("trims what the environment handed over", () => {
    assert.equal(run({ env: { CLAUDE_LAUNCHER_DEEPSEEK_KEY: "  sk-env\n" } }).key, "sk-env");
  });

  it("wins over a configured command", () => {
    const resolved = run({
      env: { CLAUDE_LAUNCHER_DEEPSEEK_KEY: "sk-env" },
      config: provider({ command: "pass show deepseek" }),
      runner: runner({ stdout: "sk-command" }),
    });
    assert.equal(resolved.key, "sk-env");
  });

  it("refuses an empty variable instead of falling through", () => {
    const message = failure({
      env: { CLAUDE_LAUNCHER_DEEPSEEK_KEY: "   " },
      config: provider({ command: "pass show deepseek" }),
      runner: runner({ stdout: "sk-command" }),
    });
    assert.match(message, /CLAUDE_LAUNCHER_DEEPSEEK_KEY is set but empty/);
  });
});

describe("resolveKey, command", () => {
  it("takes the command's stdout, trimmed", () => {
    const resolved = run({
      config: provider({ command: "pass show deepseek/api-key" }),
      runner: runner({ stdout: "sk-command\n" }),
    });
    assert.equal(resolved.key, "sk-command");
    assert.equal(resolved.source, "command");
    assert.equal(resolved.detail, "pass show deepseek/api-key");
  });

  it("wins over a literal value in the same table", () => {
    const resolved = run({
      config: provider({ command: "pass show deepseek", value: "sk-literal" }),
      runner: runner({ stdout: "sk-command" }),
    });
    assert.equal(resolved.key, "sk-command");
  });

  it("reports a non zero exit with the first line of stderr", () => {
    const message = failure({
      config: provider({ command: "pass show deepseek" }),
      runner: runner({ status: 2, stderr: "\nError: deepseek is not in the password store\nmore\n" }),
    });
    assert.match(message, /key\.command for deepseek exited 2: Error: deepseek is not in the password store/);
  });

  it("reports a failure that prints nothing to stderr", () => {
    assert.match(
      failure({ config: provider({ command: "false" }), runner: runner({ status: 1 }) }),
      /exited 1$/,
    );
  });

  it("refuses a command that printed nothing", () => {
    const message = failure({
      config: provider({ command: "pass show deepseek" }),
      runner: runner({ stdout: "\n" }),
    });
    assert.match(message, /printed nothing/);
  });

  it("reports a command that could not start", () => {
    const message = failure({
      config: provider({ command: "nope" }),
      runner: runner({ status: null, error: new Error("spawn sh ENOENT") }),
    });
    assert.match(message, /could not start: spawn sh ENOENT/);
  });

  it("reports a command killed by a signal", () => {
    const message = failure({
      config: provider({ command: "sleep 999" }),
      runner: runner({ status: null, signal: "SIGTERM" }),
    });
    assert.match(message, /killed by SIGTERM/);
  });
});

describe("resolveKey, value", () => {
  it("falls back to the literal in the config", () => {
    const resolved = run({ config: provider({ value: "sk-literal" }) });
    assert.equal(resolved.key, "sk-literal");
    assert.equal(resolved.source, "value");
  });
});

describe("resolveKey, nothing configured", () => {
  it("names the ways to supply a key when there is no terminal", () => {
    const message = failure({});
    assert.match(message, /no key for deepseek/);
    assert.match(message, /CLAUDE_LAUNCHER_DEEPSEEK_KEY/);
    assert.match(message, /key = \{ command/);
    assert.match(message, /key = \{ value/);
  });

  it("asks when there is a terminal", () => {
    const asked: string[] = [];
    const resolved = run({
      isTTY: true,
      prompt: (name) => {
        asked.push(name);
        return "sk-typed\n";
      },
    });
    assert.equal(resolved.key, "sk-typed");
    assert.equal(resolved.source, "prompt");
    assert.deepEqual(asked, ["deepseek"]);
  });

  it("refuses an empty answer", () => {
    assert.match(failure({ isTTY: true, prompt: () => "\n" }), /no key entered for deepseek/);
  });

  it("surfaces a cancelled prompt", () => {
    const message = failure({
      isTTY: true,
      prompt: () => {
        throw new KeyError("cancelled");
      },
    });
    assert.equal(message, "cancelled");
  });
});

describe("runKeyCommand", () => {
  it("captures stdout", () => {
    const outcome = runKeyCommand("printf 'sk-real\\n'");
    assert.equal(outcome.status, 0);
    assert.equal(outcome.stdout, "sk-real\n");
  });

  it("captures a non zero exit", () => {
    const outcome = runKeyCommand("exit 3");
    assert.equal(outcome.status, 3);
    assert.equal(outcome.signal, null);
  });

  it("captures a missing command", () => {
    const outcome = runKeyCommand("definitely-not-a-real-command-xyz");
    assert.equal(outcome.status, 127);
    assert.match(outcome.stderr, /not found/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelConfig, ProviderConfig } from "./config.ts";
import type { LaunchRequest } from "./launch.ts";
import { buildEnv, buildSettings, exitCode, pickerId, planLaunch } from "./launch.ts";

const FLASH: ModelConfig = {
  id: "deepseek-flash",
  label: "DeepSeek V4.1 Flash",
  context: 1024 * 1024,
  behavesAs: "claude-opus-4-7",
  description: "Reasoning and main loop.",
};

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: "https://api.deepseek.com/anthropic",
    models: [FLASH],
    defaultModel: "deepseek-flash",
    fastModel: "deepseek-flash",
    ...overrides,
  };
}

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    provider: provider(),
    model: FLASH,
    key: "sk-test",
    safe: false,
    forwarded: [],
    env: { PATH: "/usr/bin" },
    ...overrides,
  };
}

describe("pickerId", () => {
  it("leaves a model without a declared context alone", () => {
    assert.equal(pickerId({ id: "a" }), "a");
  });

  it("leaves a sub million model alone", () => {
    assert.equal(pickerId({ id: "a", context: 128 * 1024 }), "a");
  });

  it("marks a million token model for planning", () => {
    assert.equal(pickerId({ id: "a", context: 1024 * 1024 }), "a[1m]");
  });
});

describe("buildSettings", () => {
  it("offers exactly the configured models, replacing the built in ones", () => {
    const settings = buildSettings(provider());

    assert.equal(settings.disableClaudeAiConnectors, true);
    assert.deepEqual(settings.modelPicker, {
      replaceBuiltInOptions: true,
      options: [
        {
          model: "deepseek-flash[1m]",
          label: "DeepSeek V4.1 Flash",
          behavesAs: "claude-opus-4-7",
          description: "Reasoning and main loop.",
        },
      ],
    });
  });

  it("falls back to the id when a model has no label", () => {
    const settings = buildSettings(provider({ models: [{ id: "bare" }] }));
    const picker = settings.modelPicker as { options: Array<Record<string, unknown>> };
    assert.deepEqual(picker.options, [{ model: "bare", label: "bare" }]);
  });

  it("lets the settings table override a generated key", () => {
    const settings = buildSettings(
      provider({ settings: { disableClaudeAiConnectors: false, alwaysThinkingEnabled: false } }),
    );
    assert.equal(settings.disableClaudeAiConnectors, false);
    assert.equal(settings.alwaysThinkingEnabled, false);
    assert.ok(settings.modelPicker !== undefined);
  });

  it("lets the settings table replace the whole picker", () => {
    const replacement = { replaceBuiltInOptions: false, options: [] };
    const settings = buildSettings(provider({ settings: { modelPicker: replacement } }));
    assert.deepEqual(settings.modelPicker, replacement);
  });
});

describe("buildEnv", () => {
  it("points every wire variable at the selected model", () => {
    const env = buildEnv(request());

    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test");
    assert.equal(env.ANTHROPIC_MODEL, "deepseek-flash[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-flash[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-flash[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-flash[1m]");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-flash[1m]");
    assert.equal(env.CLAUDE_CODE_BG_CLASSIFIER_MODEL, "deepseek-flash[1m]");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  });

  it("never sets ANTHROPIC_API_KEY, which would gate the consent prompt", () => {
    assert.equal(buildEnv(request()).ANTHROPIC_API_KEY, undefined);
  });

  it("states the compact window as three quarters of the context", () => {
    assert.equal(buildEnv(request()).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "786432");
  });

  it("omits the compact window when the context is unknown", () => {
    const model: ModelConfig = { id: "unknown" };
    const env = buildEnv(request({ model, provider: provider({ models: [model] }) }));
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
    assert.equal(env.ANTHROPIC_MODEL, "unknown");
  });

  it("sends the fast model to the lower tiers only", () => {
    const pro: ModelConfig = { id: "mimo-v2.6-pro", context: 1024 * 1024 };
    const flash: ModelConfig = { id: "mimo-v2.6-flash", context: 1024 * 1024, fast: true };
    const env = buildEnv(
      request({
        model: pro,
        provider: provider({ models: [pro, flash], defaultModel: pro.id, fastModel: flash.id }),
      }),
    );

    assert.equal(env.ANTHROPIC_MODEL, "mimo-v2.6-pro[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "mimo-v2.6-pro[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "mimo-v2.6-pro[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "mimo-v2.6-flash[1m]");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "mimo-v2.6-flash[1m]");
    assert.equal(env.CLAUDE_CODE_BG_CLASSIFIER_MODEL, "mimo-v2.6-flash[1m]");
  });

  it("keeps the rest of the environment", () => {
    assert.equal(buildEnv(request()).PATH, "/usr/bin");
  });

  it("follows the fast model when the session switches to it", () => {
    const pro: ModelConfig = { id: "pro", context: 1024 * 1024 };
    const flash: ModelConfig = { id: "flash", context: 1024 * 1024, fast: true };
    const env = buildEnv(
      request({
        model: flash,
        provider: provider({ models: [pro, flash], defaultModel: pro.id, fastModel: flash.id }),
      }),
    );
    assert.equal(env.ANTHROPIC_MODEL, "flash[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "flash[1m]");
  });
});

describe("planLaunch", () => {
  it("passes the settings as inline JSON, never as a file", () => {
    const plan = planLaunch(request());
    assert.equal(plan.args[0], "--settings");
    assert.deepEqual(JSON.parse(plan.args[1]!), plan.settings);
  });

  it("offers the permission bypass unless asked to leave it out", () => {
    assert.ok(planLaunch(request()).args.includes("--allow-dangerously-skip-permissions"));
    assert.ok(!planLaunch(request({ safe: true })).args.includes("--allow-dangerously-skip-permissions"));
  });

  it("puts forwarded arguments last so they win", () => {
    const plan = planLaunch(request({ forwarded: ["--resume", "abc"] }));
    assert.deepEqual(plan.args.slice(-2), ["--resume", "abc"]);
  });

  it("still passes settings on an empty forward", () => {
    assert.equal(planLaunch(request()).args.length, 3);
  });
});

describe("exitCode", () => {
  it("passes the child's own status through", () => {
    assert.equal(exitCode({ status: 42, signal: null }), 42);
    assert.equal(exitCode({ status: 0, signal: null }), 0);
  });

  it("reports the shell's convention for a signal", () => {
    assert.equal(exitCode({ status: null, signal: "SIGINT" }), 130);
    assert.equal(exitCode({ status: null, signal: "SIGTERM" }), 1);
  });
});

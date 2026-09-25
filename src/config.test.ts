import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError, configPath, loadConfig } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "claude-launcher-"));
let counter = 0;

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function load(toml: string) {
  const path = join(dir, `config-${counter++}.toml`);
  writeFileSync(path, toml);
  return loadConfig({ path, env: { HOME: "/home/tester" } });
}

function failure(toml: string): string {
  try {
    load(toml);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return assert.fail("expected a ConfigError");
}

const VALID = `
[deepseek]
base_url = "https://api.deepseek.com/anthropic"
key = { command = "pass show deepseek/api-key" }

[[deepseek.models]]
id = "deepseek-flash"
label = "DeepSeek V4.1 Flash"
context = "1m"
behaves_as = "claude-opus-4-7"
description = "Reasoning and main loop."
`;

describe("loadConfig", () => {
  it("reads a provider, its models and a key command", () => {
    const config = load(VALID);
    const provider = config.providers.get("deepseek");

    assert.equal(config.providers.size, 1);
    assert.equal(provider?.baseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(provider?.key?.command, "pass show deepseek/api-key");
    assert.equal(provider?.models.length, 1);
    assert.equal(provider?.models[0]?.id, "deepseek-flash");
    assert.equal(provider?.models[0]?.label, "DeepSeek V4.1 Flash");
    assert.equal(provider?.models[0]?.behavesAs, "claude-opus-4-7");
    assert.equal(provider?.models[0]?.description, "Reasoning and main loop.");
  });

  it("defaults the model to the first one listed", () => {
    assert.equal(load(VALID).providers.get("deepseek")?.defaultModel, "deepseek-flash");
  });

  it("honours default_model", () => {
    const config = load(`
      [deepseek]
      base_url = "https://api.deepseek.com/anthropic"
      default_model = "deepseek-pro"

      [[deepseek.models]]
      id = "deepseek-flash"

      [[deepseek.models]]
      id = "deepseek-pro"
    `);
    assert.equal(config.providers.get("deepseek")?.defaultModel, "deepseek-pro");
  });

  it("normalises context shorthands to a token count", () => {
    const config = load(`
      [p]
      base_url = "https://example.test/anthropic"

      [[p.models]]
      id = "a"
      context = "1m"

      [[p.models]]
      id = "b"
      context = "128k"

      [[p.models]]
      id = "c"
      context = 200000

      [[p.models]]
      id = "d"
    `);
    const models = config.providers.get("p")?.models ?? [];
    assert.deepEqual(
      models.map((model) => model.context),
      [1_000_000, 128_000, 200_000, undefined],
    );
  });

  it("allows http on a localhost gateway", () => {
    const baseUrl = load(`
      [local]
      base_url = "http://localhost:8080/anthropic"

      [[local.models]]
      id = "whatever"
    `).providers.get("local")?.baseUrl;
    assert.equal(baseUrl, "http://localhost:8080/anthropic");
  });

  it("refuses plain http to a remote host", () => {
    const message = failure(`
      [p]
      base_url = "http://example.test/anthropic"

      [[p.models]]
      id = "a"
    `);
    assert.match(message, /unencrypted/);
    assert.match(message, /p\.base_url/);
  });

  it("names the closest key when one is misspelled", () => {
    const message = failure(`
      [p]
      base_ur1 = "https://example.test/anthropic"

      [[p.models]]
      id = "a"
    `);
    assert.match(message, /unknown key "base_ur1"/);
    assert.match(message, /did you mean "base_url"/);
  });

  it("names the closest key inside a model too", () => {
    const message = failure(`
      [p]
      base_url = "https://example.test/anthropic"

      [[p.models]]
      id = "a"
      behave_as = "claude-opus-4-7"
    `);
    assert.match(message, /p\.models\[0\]: unknown key "behave_as"/);
    assert.match(message, /did you mean "behaves_as"/);
  });

  it("refuses a reserved name as a provider", () => {
    const message = failure(`
      [add]
      base_url = "https://example.test/anthropic"

      [[add.models]]
      id = "a"
    `);
    assert.match(message, /"add" is a reserved command name/);
  });

  it("refuses a provider name that cannot be typed", () => {
    const message = failure(`
      ["Not A Slug"]
      base_url = "https://example.test/anthropic"

      [["Not A Slug".models]]
      id = "a"
    `);
    assert.match(message, /not a usable provider name/);
  });

  it("refuses two models sharing an id", () => {
    const message = failure(`
      [p]
      base_url = "https://example.test/anthropic"

      [[p.models]]
      id = "a"

      [[p.models]]
      id = "a"
    `);
    assert.match(message, /duplicate model id "a"/);
  });

  it("refuses a default_model that is not listed", () => {
    const message = failure(`
      [p]
      base_url = "https://example.test/anthropic"
      default_model = "mimo-v2.6-pro"

      [[p.models]]
      id = "deepseek-flash"
    `);
    assert.match(message, /"mimo-v2.6-pro" is not one of the models listed/);
  });

  it("refuses a provider with no models", () => {
    const message = failure(`
      [p]
      base_url = "https://example.test/anthropic"
      models = []
    `);
    assert.match(message, /at least one model is required/);
  });

  it("refuses an empty key table", () => {
    const message = failure(`
      [p]
      base_url = "https://example.test/anthropic"
      key = {}

      [[p.models]]
      id = "a"
    `);
    assert.match(message, /p\.key: set command or value/);
  });

  it("reports malformed TOML with a position", () => {
    const message = failure("a = = 1\n");
    assert.match(message, /config-\d+\.toml:1:5/);
    assert.match(message, /invalid value/);
  });

  it("reports a missing file by path", () => {
    assert.throws(
      () => loadConfig({ path: join(dir, "absent.toml"), env: { HOME: "/home/tester" } }),
      /no config file at/,
    );
  });

  it("shortens a path under the home directory", () => {
    assert.throws(
      () => loadConfig({ path: "/home/tester/.config/claude-launcher/config.toml", env: { HOME: "/home/tester" } }),
      /~\/\.config\/claude-launcher\/config\.toml/,
    );
  });
});

describe("configPath", () => {
  it("honours XDG_CONFIG_HOME", () => {
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/tester" }),
      "/xdg/claude-launcher/config.toml",
    );
  });

  it("falls back to ~/.config", () => {
    assert.equal(configPath({ HOME: "/home/tester" }), "/home/tester/.config/claude-launcher/config.toml");
  });

  it("treats an empty XDG_CONFIG_HOME as unset", () => {
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "", HOME: "/home/tester" }),
      "/home/tester/.config/claude-launcher/config.toml",
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "smol-toml";
import { builtInProvider } from "./builtins.ts";
import type { KeyConfig, ProviderConfig } from "./config.ts";
import { providerTable } from "./config.ts";
import {
  appendProvider,
  contextShorthand,
  providerLine,
  replaceProvider,
  serializeProvider,
} from "./configfile.ts";

function reparse(name: string, text: string): ProviderConfig {
  const provider = providerTable(parse(text) as Record<string, unknown>).get(name);
  assert.ok(provider !== undefined, `expected ${name} to parse back`);
  return provider;
}

// A complete stanza, since the loader rejects a provider with no models and every
// case here re-reads the whole file rather than just the part under test.
function stanza(name: string, baseUrl: string): string {
  return `[${name}]\nbase_url = "${baseUrl}"\n\n[[${name}.models]]\nid = "a"\n`;
}

function roundTrip(name: string, key?: KeyConfig) {
  const source = builtInProvider(name);
  assert.ok(source !== undefined);
  const block = serializeProvider(name, source, key);
  return { source, block, result: reparse(name, block) };
}

const FILE = `# my notes

[deepseek]
base_url = "https://old.example/anthropic"
# remember why this was set
key = { command = "pass show old" }

[[deepseek.models]]
id = "old"

[mimo]
base_url = "https://mimo.example/anthropic"

[[mimo.models]]
id = "m"
`;

describe("contextShorthand", () => {
  it("writes a round number back as a shorthand", () => {
    assert.equal(contextShorthand(1024 * 1024), "1m");
    assert.equal(contextShorthand(131072), "128k");
  });

  it("leaves an odd number alone", () => {
    assert.equal(contextShorthand(200_000), "200000");
  });
});

describe("serializeProvider", () => {
  it("survives a round trip through the real loader", () => {
    const { source, result } = roundTrip("deepseek");

    assert.equal(result.baseUrl, source?.baseUrl);
    assert.equal(result.defaultModel, source?.defaultModel);
    assert.equal(result.fastModel, source?.fastModel);
    assert.deepEqual(result.models, source?.models);
  });

  it("keeps a settings table, tables and all", () => {
    const { source, result } = roundTrip("mimo");

    assert.deepEqual(result.settings, source?.settings);
    assert.match(
      serializeProvider("mimo", source!, undefined),
      /settings = \{ alwaysThinkingEnabled = false \}/,
    );
  });

  it("writes a nested table inside settings", () => {
    const provider: ProviderConfig = {
      baseUrl: "https://example.test/anthropic",
      models: [{ id: "a", context: 1024 * 1024 }],
      defaultModel: "a",
      fastModel: "a",
      settings: { deniedMcpServers: [{ serverName: "otter" }] },
    };

    const block = serializeProvider("p", provider, undefined);
    assert.match(block, /deniedMcpServers = \[\{ serverName = "otter" \}\]/);
    assert.deepEqual(reparse("p", block).settings, provider.settings);
  });

  it("writes the key as an inline table, whichever form it takes", () => {
    assert.match(roundTrip("deepseek", { command: "pass show x" }).block, /key = \{ command = "pass show x" \}/);
    assert.match(roundTrip("deepseek", { value: "sk-1" }).block, /key = \{ value = "sk-1" \}/);
  });

  it("omits the key entirely when none was chosen", () => {
    assert.ok(!roundTrip("deepseek").block.includes("key ="));
  });

  it("writes context as a shorthand and reads the same number back", () => {
    const { block, result } = roundTrip("deepseek");
    assert.match(block, /context = "1m"/);
    assert.equal(result.models[0]?.context, 1024 * 1024);
  });

  it("only states default_model when it is not the first model", () => {
    assert.ok(!roundTrip("mimo").block.includes("default_model"));
  });
});

describe("providerLine", () => {
  it("counts from one", () => {
    assert.equal(providerLine('[deepseek]\nbase_url = "x"\n', "deepseek"), 1);
    assert.equal(providerLine("# note\n\n[mimo]\n", "mimo"), 3);
  });

  it("finds a provider whose models come first", () => {
    assert.equal(providerLine('[[mimo.models]]\nid = "a"\n', "mimo"), 1);
  });

  it("does not confuse a provider for one that starts the same", () => {
    assert.equal(providerLine("[mimo-payg]\n", "mimo"), undefined);
  });

  it("answers undefined when the provider is absent", () => {
    assert.equal(providerLine("[other]\n", "deepseek"), undefined);
  });
});

describe("appendProvider", () => {
  it("starts a new file with a header", () => {
    const text = appendProvider("", stanza("deepseek", "https://x.example"));
    assert.match(text, /^# claude-launcher providers/);
    assert.equal(reparse("deepseek", text).baseUrl, "https://x.example");
  });

  it("leaves an existing file's contents alone", () => {
    const before = `${stanza("other", "https://y.example")}\n`;
    const text = appendProvider(before, stanza("deepseek", "https://x.example"));

    assert.ok(text.startsWith(before.trimEnd()));
    assert.equal(reparse("other", text).baseUrl, "https://y.example");
    assert.equal(reparse("deepseek", text).baseUrl, "https://x.example");
  });

  it("separates stanzas with exactly one blank line", () => {
    const text = appendProvider(stanza("other", "https://y.example"), stanza("deepseek", "https://x.example"));
    const lines = text.split("\n");
    const index = lines.findIndex((line) => line === "[deepseek]");

    assert.equal(lines[index - 1], "");
    assert.notEqual(lines[index - 2], "");
  });
});

describe("replaceProvider", () => {
  it("swaps only the named stanza", () => {
    const text = replaceProvider(FILE, "deepseek", stanza("deepseek", "https://new.example"));

    assert.ok(!text.includes("old.example"));
    assert.ok(!text.includes("pass show old"));
    assert.ok(!text.includes('id = "old"'));
    assert.equal(reparse("deepseek", text).baseUrl, "https://new.example");
  });

  it("leaves the rest of the file untouched", () => {
    const text = replaceProvider(FILE, "deepseek", stanza("deepseek", "https://new.example"));

    assert.match(text, /^# my notes/);
    assert.match(text, /\[mimo\]\nbase_url = "https:\/\/mimo\.example\/anthropic"/);
    assert.match(text, /\[\[mimo\.models\]\]\nid = "m"/);
    assert.equal(reparse("mimo", text).baseUrl, "https://mimo.example/anthropic");
  });

  it("appends when the provider is not there yet", () => {
    const text = replaceProvider(FILE, "mimo-payg", stanza("mimo-payg", "https://payg.example"));

    assert.equal(reparse("mimo-payg", text).baseUrl, "https://payg.example");
    assert.equal(reparse("deepseek", text).baseUrl, "https://old.example/anthropic");
  });

  it("replaces a stanza that is last in the file", () => {
    const text = replaceProvider(FILE, "mimo", stanza("mimo", "https://new-mimo.example"));

    assert.equal(reparse("mimo", text).baseUrl, "https://new-mimo.example");
    assert.ok(text.endsWith("\n"));
    assert.ok(!text.endsWith("\n\n"));
  });

  it("can be replaced twice over, leaving no debris", () => {
    const once = replaceProvider(FILE, "deepseek", stanza("deepseek", "https://first.example"));
    const twice = replaceProvider(once, "deepseek", stanza("deepseek", "https://second.example"));

    assert.ok(!twice.includes("first.example"));
    assert.equal(reparse("deepseek", twice).baseUrl, "https://second.example");
    assert.equal(reparse("mimo", twice).baseUrl, "https://mimo.example/anthropic");
  });
});

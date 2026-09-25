import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILT_IN_PROVIDERS, builtInNames, builtInProvider } from "./builtins.ts";
import { pickerId } from "./launch.ts";

describe("the shipped providers", () => {
  it("parses cleanly, so a built in cannot be invalid", () => {
    assert.deepEqual(builtInNames(), ["deepseek", "mimo", "mimo-payg"]);
  });

  it("ships no key, which is what add exists to collect", () => {
    for (const provider of BUILT_IN_PROVIDERS.values()) {
      assert.equal(provider.key, undefined);
    }
  });

  it("describes deepseek as measured", () => {
    const provider = builtInProvider("deepseek");

    assert.equal(provider?.baseUrl, "https://api.deepseek.com/anthropic");
    assert.deepEqual(
      provider?.models.map((model) => model.id),
      ["deepseek-flash"],
    );
    assert.equal(provider?.defaultModel, "deepseek-flash");
    assert.equal(provider?.fastModel, "deepseek-flash");
    assert.equal(provider?.models[0]?.context, 1024 * 1024);
    assert.equal(provider?.models[0]?.behavesAs, "claude-opus-4-7");
    assert.equal(provider?.settings, undefined);
  });

  it("splits mimo's tiers and turns its thinking switch off", () => {
    const provider = builtInProvider("mimo");

    assert.equal(provider?.defaultModel, "mimo-v2.6-pro");
    assert.equal(provider?.fastModel, "mimo-v2.6-flash");
    assert.deepEqual(provider?.settings, { alwaysThinkingEnabled: false });
  });

  it("sends the two mimo products to different hosts", () => {
    assert.equal(builtInProvider("mimo")?.baseUrl, "https://token-plan-cn.xiaomimimo.com/anthropic");
    assert.equal(builtInProvider("mimo-payg")?.baseUrl, "https://api.xiaomimimo.com/anthropic");
  });

  it("gives both mimo products the same models", () => {
    const plan = builtInProvider("mimo");
    const payg = builtInProvider("mimo-payg");

    assert.deepEqual(payg?.models, plan?.models);
    assert.deepEqual(payg?.settings, plan?.settings);
  });

  it("marks every shipped model for 1M planning", () => {
    for (const provider of BUILT_IN_PROVIDERS.values()) {
      for (const model of provider.models) {
        assert.equal(pickerId(model), `${model.id}[1m]`);
      }
    }
  });

  it("answers undefined for a provider that is not shipped", () => {
    assert.equal(builtInProvider("anthropic"), undefined);
  });
});

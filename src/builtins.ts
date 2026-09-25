import { parse } from "smol-toml";
import { type ProviderConfig, providerTable } from "./config.ts";

// Written in the same format a user writes, so a stanza can be copied between the
// two, and parsed by the same validator so a built in cannot drift from the schema.
//
// Every value here was measured against the live gateway rather than taken from
// provider documentation. Only models that were actually exercised appear, which is
// why DeepSeek lists one model and not the whole V4 line.
//
// No key: the point of `add` is to collect one from whichever source the user wants.
const BUILT_IN_TOML = `
[deepseek]
base_url = "https://api.deepseek.com/anthropic"

[[deepseek.models]]
id          = "deepseek-flash"
label       = "DeepSeek V4.1 Flash"
context     = "1m"
behaves_as  = "claude-opus-4-7"
description = "1M context, native multimodal. Reasoning and main loop."

[mimo]
base_url      = "https://token-plan-cn.xiaomimimo.com/anthropic"
default_model = "mimo-v2.6-pro"
settings      = { alwaysThinkingEnabled = false }

[[mimo.models]]
id          = "mimo-v2.6-pro"
label       = "MiMo V2.6 Pro"
context     = "1m"
behaves_as  = "claude-opus-4-7"
description = "1M context, full-modal. Reasoning and main loop."

[[mimo.models]]
id          = "mimo-v2.6-flash"
label       = "MiMo V2.6 Flash"
context     = "1m"
behaves_as  = "claude-opus-4-7"
description = "1M context, full-modal. Subagents, background, volume."
fast        = true

# The same product on the pay as you go endpoint. The keys are not
# interchangeable between the two, so this needs its own pass entry.
[mimo-payg]
base_url      = "https://api.xiaomimimo.com/anthropic"
default_model = "mimo-v2.6-pro"
settings      = { alwaysThinkingEnabled = false }

[[mimo-payg.models]]
id          = "mimo-v2.6-pro"
label       = "MiMo V2.6 Pro"
context     = "1m"
behaves_as  = "claude-opus-4-7"
description = "1M context, full-modal. Reasoning and main loop."

[[mimo-payg.models]]
id          = "mimo-v2.6-flash"
label       = "MiMo V2.6 Flash"
context     = "1m"
behaves_as  = "claude-opus-4-7"
description = "1M context, full-modal. Subagents, background, volume."
fast        = true
`;

export const BUILT_IN_PROVIDERS: Map<string, ProviderConfig> = providerTable(
  parse(BUILT_IN_TOML) as Record<string, unknown>,
);

export function builtInNames(): string[] {
  return [...BUILT_IN_PROVIDERS.keys()];
}

export function builtInProvider(name: string): ProviderConfig | undefined {
  return BUILT_IN_PROVIDERS.get(name);
}

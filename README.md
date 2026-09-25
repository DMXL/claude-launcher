# claude-launcher

Run Claude Code against any model.

It launches the Claude Code you already have, pointed at a provider that speaks the Anthropic Messages API. DeepSeek today, MiMo today, something else tomorrow.

The examples below invoke `claude-launcher` by its full name. It ships as one binary, and the first positional names the provider. Because provider names occupy that slot, `add`, `list`, `doctor` and `config` are reserved and cannot be used as provider names.

```sh
claude-launcher deepseek
claude-launcher mimo --model mimo-v2.6-pro
claude-launcher deepseek --safe
```

No proxy, no shim, no patched binary, no fork. Everything Anthropic ships in the client (tools, skills, MCP servers, subagents, permissions, session history, `CLAUDE.md`) keeps working. Only the model behind it changes.

## The idea

Claude Code is two separable things. One is a harness: the agent loop, the tool implementations, permissions, context management, session state. The other is a model. The harness talks to the model over the Anthropic Messages API, and it will talk to anything that speaks that API, because `ANTHROPIC_BASE_URL` is just a string.

A growing set of providers now ship an Anthropic-compatible gateway alongside their OpenAI-compatible one, because it is the cheapest way to be usable from Claude Code:

| Provider | Gateway | Models |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `deepseek-flash` and the rest of the V4 line |
| Xiaomi MiMo | `https://token-plan-cn.xiaomimimo.com/anthropic` | `mimo-v2.6-pro`, `mimo-v2.6-flash` |

So the launcher is not a translation layer. It is three environment variables pointing Claude Code at a different host, plus the dozen small corrections that stand between "it responds" and "it behaves like a first class model in the picker". Those corrections are the whole project. Each one is a thing Claude Code does differently when it does not recognise the model you named.

## What it corrects

**The invocation is scoped, and nothing is left behind.** Every variable is set for one process. A plain `claude` in the same shell still reaches Anthropic, and there is nothing to unset afterwards. State under `~/.claude` is shared by default, so your skills, MCP servers and history come along; set `CLAUDE_CONFIG_DIR` to run against isolated state instead.

**The model picker is curated.** Claude Code's `/model` offers Opus, Sonnet and Haiku, none of which your gateway serves, so selecting one is a guaranteed failure with a confusing error. The launcher replaces the built-in options with the ones the provider actually serves, and disables the claude.ai connectors prompt, which is meaningless here. This rides in as inline `--settings` JSON, so `~/.claude/settings.json` is never written to.

**Unknown models inherit known capability defaults.** Claude Code carries a per-model profile: whether it can use adaptive thinking, what effort level to launch with, whether it supports a lean prompt. A model absent from its catalog gets no profile. `behavesAs` maps the provider's model onto the closest model Claude Code does know, borrowing that profile without touching the model ID sent on the wire. This matters more than it sounds: it is the difference between a model that thinks and one that answers instantly.

**The context window is stated, not guessed.** Anything Claude Code does not recognise gets assumed at 200k. Providers with a larger window need it declared, both for the `[1m]` planning hint on the model ID and for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which is where compaction actually triggers.

**Subagents and background models are redirected too.** `ANTHROPIC_DEFAULT_OPUS_MODEL` and friends, plus `CLAUDE_CODE_SUBAGENT_MODEL`, otherwise send subagent traffic to model names your gateway has never heard of. The bash security check runs non-streaming and needs its own model, or it fails silently on a catalog default that does not exist.

**The auth variable is chosen deliberately.** `ANTHROPIC_AUTH_TOKEN` rather than `ANTHROPIC_API_KEY`. Providers accept either, but setting both trips a startup warning, and `ANTHROPIC_API_KEY` alone gates a "use this custom API key?" consent prompt. One variable means neither appears.

## Providers are data

Adding a provider is a config entry, not a code change.

```toml
# ~/.config/claude-launcher/config.toml
[deepseek]
base_url = "https://api.deepseek.com/anthropic"
key = { command = "pass show deepseek/api-key" }

[[deepseek.models]]
id         = "deepseek-flash"
label      = "DeepSeek V4.1 Flash"
context    = "1m"
behaves_as = "claude-opus-4-7"
description = "1M context, native multimodal. Reasoning and main loop."
```

`behaves_as` is deliberately pinned to a specific known model rather than a tier, because the profiles differ. On a 1M model with no fast mode, no lean prompt and no refusal fallback, borrowing a profile that claims those features produces requests the gateway rejects.

The file is read from `$XDG_CONFIG_HOME/claude-launcher/config.toml`, falling back to `~/.config/claude-launcher/config.toml`. `context` takes a token count or a shorthand, so `"1m"`, `"128k"` and `200000` all work. `default_model` names the entry `claude-launcher deepseek` picks; leave it out and the first model listed wins.

A key the loader does not recognise is an error rather than a shrug, since a misspelled `base_url` would otherwise be a silently ignored setting:

```
config.toml: deepseek.models[0]: unknown key "behave_as"
  did you mean "behaves_as"?
```

`base_url` must be https, unless it points at localhost, where a plain http gateway is allowed and no key leaves the machine.

## Keys

The launcher reads a key from the first source that answers:

1. `CLAUDE_LAUNCHER_<PROVIDER>_KEY`, so `CLAUDE_LAUNCHER_DEEPSEEK_KEY`, for CI and one off runs
2. the `key.command` in the config, run through a shell and read from stdout
3. the `key.value` in the config, for people who keep their config file private
4. an interactive prompt, which can be saved to whichever of the above you choose

A source that answers badly is an error rather than a reason to try the next one. A variable exported but empty, or a `key.command` that exits non zero, or one that prints nothing, stops the launch and says which of those happened. Falling through would mean using a key you did not intend, which is harder to notice than a failure.

The prompt is the last resort, and only appears when stdin is a terminal. Without one the launcher names the variable and both config forms instead of hanging, so CI fails fast rather than waiting on input that will never arrive.

Nothing assumes a password manager. `pass`, `op`, `security`, `gpg` and a file of your own are all just a command that prints a key on stdout. Guided setup is the intended path:

```sh
claude-launcher add deepseek
```

## Install

Not yet. The config loads and is validated, but nothing is wired to Claude Code, so there is nothing to install. To run what exists:

```sh
pnpm install
pnpm build
./dist/index.js deepseek
pnpm test
pnpm typecheck
```

`pnpm dev` runs the TypeScript directly on Node 23.6 or later. Source files import each other with `.ts` extensions, which `tsc` rewrites to `.js` on the way out, the one arrangement that lets the same files run unevaluated under Node and compile for publishing.

The shape will be a Node.js package, installable globally with `pnpm add -g claude-launcher`, with the CLI decoupled from any shell. It is marked `private` until the licence is settled, so a stray `pnpm publish` cannot ship it. The zsh functions this grew out of remain usable on their own for anyone who wants a shell function rather than an installed CLI.

## Why not just export the variables

You can, and for one provider you should. It stops working for you at the second provider, or the first time you want a model that is not in Claude Code's catalog and Claude Code starts quietly assuming a 200k window, or the day a subagent request goes to an Opus model name your gateway rejects. This project is the collected set of those failures, each measured against a real gateway, written down as configuration instead of tribal knowledge.

## Licence

To be decided before the first release.

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
| Xiaomi MiMo, token plan | `https://token-plan-cn.xiaomimimo.com/anthropic` | `mimo-v2.6-pro`, `mimo-v2.6-flash` |
| Xiaomi MiMo, pay as you go | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.6-pro`, `mimo-v2.6-flash` |

So the launcher is not a translation layer. It is three environment variables pointing Claude Code at a different host, plus the dozen small corrections that stand between "it responds" and "it behaves like a first class model in the picker". Those corrections are the whole project. Each one is a thing Claude Code does differently when it does not recognise the model you named.

## What it corrects

**The invocation is scoped, and nothing is left behind.** Every variable is set for one process. A plain `claude` in the same shell still reaches Anthropic, and there is nothing to unset afterwards. State under `~/.claude` is shared by default, so your skills, MCP servers and history come along; set `CLAUDE_CONFIG_DIR` to run against isolated state instead.

**The model picker is curated.** Claude Code's `/model` offers Opus, Sonnet and Haiku, none of which your gateway serves, so selecting one is a guaranteed failure with a confusing error. The launcher replaces the built-in options with the ones the provider actually serves, and disables the claude.ai connectors prompt, which is meaningless here. This rides in as inline `--settings` JSON, so `~/.claude/settings.json` is never written to.

**Unknown models inherit known capability defaults.** Claude Code carries a per-model profile: whether it can use adaptive thinking, what effort level to launch with, whether it supports a lean prompt. A model absent from its catalog gets no profile. `behavesAs` maps the provider's model onto the closest model Claude Code does know, borrowing that profile without touching the model ID sent on the wire. This matters more than it sounds: it is the difference between a model that thinks and one that answers instantly.

**The context window is stated, not guessed.** Anything Claude Code does not recognise gets assumed at 200k. Providers with a larger window need it declared, both for the `[1m]` planning hint on the model ID and for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which is where compaction actually triggers. The suffix is appended only once the declared context reaches a million tokens, and the compact window is set to three quarters of it, which is 786432 for a 1M model.

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
id          = "deepseek-flash"
label       = "DeepSeek V4.1 Flash"
context     = "1m"
behaves_as  = "claude-opus-4-7"
description = "1M context, native multimodal. Reasoning and main loop."
```

A provider that serves a second, cheaper model for the lower tiers marks it `fast`:

```toml
[mimo]
base_url      = "https://token-plan-cn.xiaomimimo.com/anthropic"
key           = { command = "pass show mimo/api-key" }
default_model = "mimo-v2.6-pro"
settings      = { alwaysThinkingEnabled = false }

[[mimo.models]]
id         = "mimo-v2.6-pro"
context    = "1m"
behaves_as = "claude-opus-4-7"

[[mimo.models]]
id         = "mimo-v2.6-flash"
context    = "1m"
behaves_as = "claude-opus-4-7"
fast       = true
```

The selected model drives the main loop, and the entry marked `fast` takes the lower tiers: the Haiku slot, subagents, and the background classifier. With no `fast` entry every tier follows the selection, which is what a single model provider wants.

`settings` is copied into the `--settings` JSON verbatim. It is the escape hatch for a key this project does not model, and it is the one place a typo does not fail: a misspelled key there is silently ignored, because validating it would mean tracking a schema that belongs to Claude Code. Everything outside that table is checked.

`behaves_as` is deliberately pinned to a specific known model rather than a tier, because the profiles differ. On a 1M model with no fast mode, no lean prompt and no refusal fallback, borrowing a profile that claims those features produces requests the gateway rejects.

The file is read from `$XDG_CONFIG_HOME/claude-launcher/config.toml`, falling back to `~/.config/claude-launcher/config.toml`. `context` takes a token count or a power of two shorthand, so `"1m"` is 1048576 tokens and `"128k"` is 131072. `default_model` names the entry `claude-launcher deepseek` picks; leave it out and the first model listed wins.

A key the loader does not recognise is an error rather than a shrug, since a misspelled `base_url` would otherwise be a silently ignored setting:

```
config.toml: deepseek.models[0]: unknown key "behave_as"
  did you mean "behaves_as"?
```

`base_url` must be https, unless it points at localhost, where a plain http gateway is allowed and no key leaves the machine.

## Known providers

Three definitions ship, and `add` writes a stanza from one of them:

| Name | Endpoint |
|---|---|
| `deepseek` | `api.deepseek.com/anthropic` |
| `mimo` | `token-plan-cn.xiaomimimo.com/anthropic` |
| `mimo-payg` | `api.xiaomimimo.com/anthropic` |

These are definitions rather than defaults. Nothing takes effect unless `config.toml` names it, so what a launch does is always what you can read in your own config file. They carry no key, because `add` exists to collect one from whichever source you prefer.

The two MiMo entries are the same product on two endpoints, and the keys are not interchangeable between them. Choosing between the two is choosing which key you hold, not which is better.

Every value in these was measured against the live gateway, in both cases with a real tool call rather than a text reply. That is why DeepSeek lists `deepseek-flash` alone rather than the whole V4 line: a model nobody exercised is a claim nobody checked.

## Keys

The launcher reads a key from the first source that answers:

1. `CLAUDE_LAUNCHER_<PROVIDER>_KEY`, so `CLAUDE_LAUNCHER_DEEPSEEK_KEY`, for CI and one off runs
2. the `key.command` in the config, run through a shell and read from stdout
3. the `key.value` in the config, for people who keep their config file private
4. an interactive prompt, which can be saved to whichever of the above you choose

A source that answers badly is an error rather than a reason to try the next one. A variable exported but empty, or a `key.command` that exits non zero, or one that prints nothing, stops the launch and says which of those happened. Falling through would mean using a key you did not intend, which is harder to notice than a failure.

The prompt is the last resort, and only appears when stdin is a terminal. Without one the launcher names the variable and both config forms instead of hanging, so CI fails fast rather than waiting on input that will never arrive.

Nothing assumes a password manager. `pass`, `op`, `security`, `gpg` and a file of your own are all just a command that prints a key on stdout.

## Setting one up

```sh
claude-launcher add deepseek
```

`add` takes the key at a hidden prompt and asks where it should live. Only vaults already installed are offered, so nothing on the menu can fail for a reason you cannot see before choosing it:

| Vault | Ends up in the config as |
|---|---|
| `pass` | `key = { command = "pass show <item>" }` |
| 1Password | `key = { command = "op read op://<vault>/<item>/credential" }` |
| macOS keychain | `key = { command = "security find-generic-password -a <acct> -s <svc> -w" }` |
| `secret-tool` | `key = { command = "secret-tool lookup service <provider> key api-key" }` |

The secret reaches the storing command on stdin and never as an argument, because an argument is world readable in `/proc` for as long as the process lives. Two of those CLIs accept a secret only as an argument, so the launcher pipes it in and has the shell read it into a variable first. That CLI's own argument list is still visible for an instant, which nothing here can change.

The menu also offers writing the key into `config.toml` in the clear, naming a command of your own, and storing nothing at all, which prints an `export` line on stdout and writes no key anywhere. The last is the shape a CI job wants.

Of those four vaults, `pass` is the only one exercised on the machine this was built on. The other three are transcribed from their own documentation and have not been run, so treat their command shapes as unverified until someone does. Nothing is hidden by that: the read command is written into your config in plain sight, and a wrong one is a one line edit.

What it writes is a stanza for that provider, and it refuses to touch one that already exists, naming the line your version is on. `--force` replaces that stanza in place and leaves the rest of the file, comments and all, exactly as it was.

Then it reads the file back through the same loader a launch uses, resolves the key the way a launch would, and sends one small request to the gateway. A rejected key or a wrong endpoint is reported here rather than during your first session.

```sh
claude-launcher list
```

`list` shows what is shipped, what your config defines, and where each configured provider gets its key from. It never prints a key.

## Usage

```sh
claude-launcher deepseek
claude-launcher deepseek --model deepseek-flash
claude-launcher mimo --safe
claude-launcher deepseek -- -p "explain this repo"
```

`--model <id>` picks the model for the session and must be one the provider lists. Naming a model belonging to a different provider is an error here, rather than a request the gateway rejects with something less clear.

`--safe` leaves out `--allow-dangerously-skip-permissions`, which is passed by default so that the bypass is available as an option in session. It does not enable the bypass by itself. Pass `--safe` when an unfamiliar model is about to touch a repo you care about.

Anything else is forwarded to Claude Code, so `--resume`, `-p`, `--add-dir` and the rest behave as they normally do. A `--` sends every remaining argument through untouched, including anything that looks like a launcher option.

The first positional names the provider, which is why the reserved command names cannot be used as providers. `add` and `list` are built; `doctor` and `config` are still just reserved.

## Install

Not yet on a registry. To run it from a checkout:

```sh
pnpm install
pnpm build
./dist/index.js add deepseek
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

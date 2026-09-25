import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "smol-toml";
import { builtInNames, builtInProvider } from "./builtins.ts";
import {
  type KeyConfig,
  type ModelConfig,
  type ProviderConfig,
  configPath,
  providerTable,
  shortenPath,
} from "./config.ts";
import { appendProvider, providerLine, replaceProvider, serializeProvider } from "./configfile.ts";
import { KeyError, envVarName, resolveKey } from "./key.ts";
import { fail, result, say } from "./output.ts";
import { Interrupted, promptHidden, promptLine } from "./prompt.ts";
import { probeGateway } from "./probe.ts";
import { didYouMean } from "./suggest.ts";
import { type VaultIO, availableVaults } from "./vaults.ts";

export interface AddOptions {
  force?: boolean;
  path?: string;
  env?: NodeJS.ProcessEnv;
}

interface Storage {
  label: string;
  run: () => KeyConfig | undefined;
}

function vaultIO(key: string, env: NodeJS.ProcessEnv): VaultIO {
  return {
    secret: key,
    env,
    ask: (question) => promptLine(question),
    run: (command, stdin) => {
      const result = spawnSync(command, {
        shell: true,
        input: stdin ?? "",
        stdio: [stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"],
        env,
      });
      if (result.error !== undefined) {
        throw new Error(`${command} could not start: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`${command} exited ${result.status}`);
      }
    },
  };
}

function storageOptions(providerName: string, key: string, env: NodeJS.ProcessEnv): Storage[] {
  const io = vaultIO(key, env);

  // Only vaults that are actually installed are offered, so nothing in the menu can
  // fail for a reason the user cannot see before choosing it.
  const options: Storage[] = availableVaults(env).map((vault) => ({
    label: vault.label,
    run: () => vault.store(providerName, io),
  }));

  options.push({
    label: "write it into config.toml as key.value, in the clear",
    run: () => ({ value: key }),
  });

  options.push({
    label: "read it from a command you name, such as gpg or a file of your own",
    run: () => {
      const command = promptLine("  command: ").trim();
      if (command === "") throw new Error("no command given");
      return { command };
    },
  });

  options.push({
    label: "store nothing, and print an export line instead",
    run: () => {
      result(`export ${envVarName(providerName)}=${key}`);
      return undefined;
    },
  });

  return options;
}

function chooseStorage(providerName: string, key: string, env: NodeJS.ProcessEnv): KeyConfig | undefined {
  const options = storageOptions(providerName, key, env);

  say("");
  say("Where should the key live?");
  options.forEach((option, index) => say(`  ${index + 1}. ${option.label}`));

  const answer = promptLine("Choose [1]: ").trim() || "1";
  const chosen = Number(answer);
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > options.length) {
    throw new Error(`expected a number from 1 to ${options.length}`);
  }

  return options[chosen - 1]!.run();
}

export async function runAdd(name: string, options: AddOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const path = options.path ?? configPath(env);
  const shown = shortenPath(path, env);

  const provider = builtInProvider(name);
  if (provider === undefined) {
    const shipped = builtInNames();
    return fail(
      `nothing is shipped under "${name}"${didYouMean(name, shipped)}\n  shipped providers: ${shipped.join(", ")}`,
    );
  }

  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return fail(`cannot read ${shown}: ${(error as Error).message}`);
    }
  }

  const existing = providerLine(text, name);
  if (existing !== undefined && options.force !== true) {
    return fail(
      `${name} is already configured at ${shown}:${existing}\n  re-run with --force to replace that stanza, or edit the file`,
    );
  }

  if (process.stdin.isTTY !== true) {
    return fail("add needs a terminal, because it asks for a key");
  }

  say(`Adding ${name}, ${provider.baseUrl}`);

  let key: string;
  try {
    key = promptHidden(`Key for ${name}: `).trim();
  } catch (error) {
    if (error instanceof Interrupted) return fail("cancelled");
    throw error;
  }
  if (key === "") return fail(`no key entered for ${name}`);

  let chosen: KeyConfig | undefined;
  try {
    chosen = chooseStorage(name, key, env);
  } catch (error) {
    if (error instanceof Interrupted) return fail("cancelled");
    return fail((error as Error).message);
  }

  const block = serializeProvider(name, provider, chosen);
  const updated = existing === undefined ? appendProvider(text, block) : replaceProvider(text, name, block);

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, updated);
  } catch (error) {
    return fail(`could not write ${shown}: ${(error as Error).message}`);
  }

  say("");
  say(`${existing === undefined ? "wrote" : "replaced"} [${name}] in ${shown}`);

  // Read the file back through the real loader, so what gets tested is what a launch
  // will use, and a stanza this wrote that does not parse is caught here.
  let reloaded: ProviderConfig;
  try {
    const parsed = providerTable(parse(updated) as Record<string, unknown>).get(name);
    if (parsed === undefined) return fail(`${name} is missing from ${shown} after writing`);
    reloaded = parsed;
  } catch (error) {
    return fail(`${shown} does not load after writing: ${(error as Error).message}`);
  }

  if (chosen !== undefined) {
    try {
      key = resolveKey(name, reloaded, { env, isTTY: false }).key;
    } catch (error) {
      if (error instanceof KeyError) return fail(error.message);
      throw error;
    }
  }

  const model: ModelConfig =
    reloaded.models.find((candidate) => candidate.id === reloaded.defaultModel) ?? reloaded.models[0]!;

  say("");
  say(`Testing ${reloaded.baseUrl}`);

  const outcome = await probeGateway(reloaded, model, key);
  say(outcome.ok ? `  ok, ${outcome.detail}` : `  failed, ${outcome.detail}`);

  if (!outcome.ok) {
    say("");
    say(`The stanza is written. Fix the key or the endpoint, then run claude-launcher ${name}`);
    return 1;
  }

  say("");
  say(`Ready. Run: claude-launcher ${name}`);
  return 0;
}

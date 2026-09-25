import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { KeyConfig } from "./config.ts";

// The secret always arrives on the command's stdin, never in the command text. A
// vault whose CLI only takes it as an argument therefore begins with this, which
// keeps the secret out of both our argv and the child's environment. It does not
// keep it out of that CLI's own argv, which nothing here can fix.
const LIFT_SECRET = "read -r k; ";

export interface VaultIO {
  secret: string;
  env: NodeJS.ProcessEnv;
  ask: (question: string) => string;
  run: (command: string, stdin?: string) => void;
}

export interface Vault {
  label: string;
  binary: string;
  store: (providerName: string, io: VaultIO) => KeyConfig;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9._@%+,:=/-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function answered(value: string, otherwise: string): string {
  return value.trim() === "" ? otherwise : value.trim();
}

export const VAULTS: Vault[] = [
  {
    label: "store it with pass",
    binary: "pass",
    store: (providerName, io) => {
      const item = answered(io.ask(`  pass item [${providerName}/api-key]: `), `${providerName}/api-key`);
      io.run(`pass insert -m -f ${shellArg(item)}`, io.secret);
      return { command: `pass show ${shellArg(item)}` };
    },
  },
  {
    label: "store it in 1Password",
    binary: "op",
    store: (providerName, io) => {
      const vault = answered(io.ask("  1Password vault [Private]: "), "Private");
      const title = answered(io.ask(`  1Password item name [${providerName}]: `), providerName);
      io.run(
        `${LIFT_SECRET}op item create --category="API Credential" --title=${shellArg(title)} --vault=${shellArg(vault)} credential="$k"`,
        io.secret,
      );
      return { command: `op read ${shellArg(`op://${vault}/${title}/credential`)}` };
    },
  },
  {
    label: "store it in the macOS keychain",
    binary: "security",
    store: (providerName, io) => {
      const account = answered(io.ask(`  keychain account [${io.env.USER ?? ""}]: `), io.env.USER ?? "");
      const service = answered(
        io.ask(`  keychain service [claude-launcher/${providerName}]: `),
        `claude-launcher/${providerName}`,
      );
      io.run(
        `${LIFT_SECRET}security add-generic-password -a ${shellArg(account)} -s ${shellArg(service)} -w "$k" -U`,
        io.secret,
      );
      return { command: `security find-generic-password -a ${shellArg(account)} -s ${shellArg(service)} -w` };
    },
  },
  {
    label: "store it with secret-tool, the desktop keyring",
    binary: "secret-tool",
    store: (providerName, io) => {
      io.run(
        `secret-tool store --label=${shellArg(`claude-launcher ${providerName}`)} service ${shellArg(providerName)} key api-key`,
        io.secret,
      );
      return { command: `secret-tool lookup service ${shellArg(providerName)} key api-key` };
    },
  },
];

function hasCommand(binary: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(":").some((directory) => {
    if (directory === "") return false;
    try {
      accessSync(join(directory, binary), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function availableVaults(env: NodeJS.ProcessEnv): Vault[] {
  return VAULTS.filter((vault) => hasCommand(vault.binary, env));
}

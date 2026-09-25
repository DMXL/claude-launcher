import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { didYouMean } from "./suggest.ts";

export const RESERVED_PROVIDER_NAMES: readonly string[] = ["add", "list", "doctor", "config"];

const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PROVIDER_KEYS = ["base_url", "key", "models", "default_model"];
const MODEL_KEYS = ["id", "label", "context", "behaves_as", "description"];
const KEY_KEYS = ["command", "value"];
const SOURCE = "config.toml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface KeyConfig {
  command?: string;
  value?: string;
}

export interface ModelConfig {
  id: string;
  label?: string;
  context?: number;
  behavesAs?: string;
  description?: string;
}

export interface ProviderConfig {
  baseUrl: string;
  key?: KeyConfig;
  models: ModelConfig[];
  defaultModel: string;
}

export interface Config {
  path: string;
  providers: Map<string, ProviderConfig>;
}

export interface LoadOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${where}: expected a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : requireString(value, where);
}

function rejectUnknownKeys(table: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${where}: unknown key "${key}"${didYouMean(key, allowed)}`);
    }
  }
}

function shortenPath(path: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? homedir();
  return home !== "" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(env.HOME ?? homedir(), ".config");
  return join(base, "claude-launcher", "config.toml");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function parseBaseUrl(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${where}.base_url: expected a non-empty string`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${where}.base_url: "${value}" is not a valid URL`);
  }

  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) {
    return value;
  }

  throw new ConfigError(
    `${where}.base_url: refusing "${url.protocol}//", which would send your key unencrypted. Use https, or a localhost gateway.`,
  );
}

function parseContext(value: unknown, where: string): number {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 0) return value;
    throw new ConfigError(`${where}: context must be a positive whole number of tokens`);
  }

  if (typeof value === "string") {
    const match = /^(\d+)([km])?$/i.exec(value.trim());
    const digits = match?.[1];
    if (digits !== undefined) {
      const count = Number(digits);
      if (count > 0) {
        const unit = match?.[2]?.toLowerCase();
        if (unit === "m") return count * 1_000_000;
        if (unit === "k") return count * 1_000;
        return count;
      }
    }
  }

  throw new ConfigError(`${where}: context must be a token count, or a shorthand like "128k" or "1m"`);
}

function parseKey(value: unknown, where: string): KeyConfig {
  if (!isTable(value)) {
    throw new ConfigError(`${where}.key: expected a table like { command = "pass show deepseek/api-key" }`);
  }

  rejectUnknownKeys(value, KEY_KEYS, `${where}.key`);

  const key: KeyConfig = {};
  const command = optionalString(value.command, `${where}.key.command`);
  const literal = optionalString(value.value, `${where}.key.value`);
  if (command !== undefined) key.command = command;
  if (literal !== undefined) key.value = literal;

  if (command === undefined && literal === undefined) {
    throw new ConfigError(`${where}.key: set command or value, or remove the table entirely`);
  }

  return key;
}

function parseModels(value: unknown, where: string): ModelConfig[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${where}.models: expected an array of tables`);
  }

  const seen = new Set<string>();

  return value.map((entry, index) => {
    const at = `${where}.models[${index}]`;
    if (!isTable(entry)) {
      throw new ConfigError(`${at}: expected a table`);
    }

    rejectUnknownKeys(entry, MODEL_KEYS, at);

    if (entry.id === undefined) {
      throw new ConfigError(`${at}: id is required`);
    }
    const id = requireString(entry.id, `${at}.id`);
    if (seen.has(id)) {
      throw new ConfigError(`${at}.id: duplicate model id "${id}"`);
    }
    seen.add(id);

    const model: ModelConfig = { id };
    const label = optionalString(entry.label, `${at}.label`);
    const behavesAs = optionalString(entry.behaves_as, `${at}.behaves_as`);
    const description = optionalString(entry.description, `${at}.description`);
    if (label !== undefined) model.label = label;
    if (behavesAs !== undefined) model.behavesAs = behavesAs;
    if (description !== undefined) model.description = description;
    if (entry.context !== undefined) model.context = parseContext(entry.context, `${at}.context`);

    return model;
  });
}

function parseProvider(name: string, value: unknown): ProviderConfig {
  const where = `${SOURCE}: ${name}`;

  if (!isTable(value)) {
    throw new ConfigError(`${where}: expected a table`);
  }
  rejectUnknownKeys(value, PROVIDER_KEYS, where);

  if (value.base_url === undefined) {
    throw new ConfigError(`${where}: base_url is required`);
  }
  if (value.models === undefined) {
    throw new ConfigError(`${where}: models is required`);
  }

  const models = parseModels(value.models, where);
  if (models.length === 0) {
    throw new ConfigError(`${where}.models: at least one model is required`);
  }

  let defaultModel = models[0]!.id;
  if (value.default_model !== undefined) {
    defaultModel = requireString(value.default_model, `${where}.default_model`);
    if (!models.some((model) => model.id === defaultModel)) {
      const known = models.map((model) => model.id);
      throw new ConfigError(
        `${where}.default_model: "${defaultModel}" is not one of the models listed${didYouMean(defaultModel, known)}`,
      );
    }
  }

  const provider: ProviderConfig = {
    baseUrl: parseBaseUrl(value.base_url, where),
    models,
    defaultModel,
  };

  if (value.key !== undefined) provider.key = parseKey(value.key, where);

  return provider;
}

export function loadConfig(options: LoadOptions = {}): Config {
  const env = options.env ?? process.env;
  const path = options.path ?? configPath(env);
  const shown = shortenPath(path, env);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`no config file at ${shown}`);
    }
    throw new ConfigError(`cannot read ${shown}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const detail = error.message.replace(/^Invalid TOML document:\s*/, "");
      throw new ConfigError(`${shown}:${error.line}:${error.column}: ${detail.trimEnd()}`);
    }
    throw error;
  }

  const providers = new Map<string, ProviderConfig>();
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (RESERVED_PROVIDER_NAMES.includes(name)) {
      throw new ConfigError(`${SOURCE}: "${name}" is a reserved command name, so it cannot name a provider`);
    }
    if (!PROVIDER_NAME.test(name)) {
      throw new ConfigError(
        `${SOURCE}: "${name}" is not a usable provider name. Use lowercase letters, digits and hyphens, and do not start with a hyphen.`,
      );
    }
    providers.set(name, parseProvider(name, value));
  }

  return { path, providers };
}

export function displayPath(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return shortenPath(config.path, env);
}

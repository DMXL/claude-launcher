import type { KeyConfig, ProviderConfig } from "./config.ts";

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const HEADER = /^\[\[?\s*([^\]\[]+?)\s*\]\]?\s*(?:#.*)?$/;
const FILE_HEADER = "# claude-launcher providers. See the README for the schema.";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`);
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error(`cannot write a ${typeof value} into TOML`);
}

// 1048576 reads better as "1m", and the loader turns it back into the same number.
export function contextShorthand(tokens: number): string {
  if (tokens % (1024 * 1024) === 0) return `${tokens / (1024 * 1024)}m`;
  if (tokens % 1024 === 0) return `${tokens / 1024}k`;
  return String(tokens);
}

function contextValue(tokens: number): string {
  return tokens % 1024 === 0 ? tomlString(contextShorthand(tokens)) : String(tokens);
}

export function serializeProvider(
  name: string,
  provider: ProviderConfig,
  key: KeyConfig | undefined,
): string {
  const lines = [`[${name}]`, `base_url = ${tomlString(provider.baseUrl)}`];

  if (key?.command !== undefined) {
    lines.push(`key = { command = ${tomlString(key.command)} }`);
  } else if (key?.value !== undefined) {
    lines.push(`key = { value = ${tomlString(key.value)} }`);
  }

  if (provider.defaultModel !== provider.models[0]?.id) {
    lines.push(`default_model = ${tomlString(provider.defaultModel)}`);
  }

  if (provider.settings !== undefined) {
    lines.push(`settings = ${tomlValue(provider.settings)}`);
  }

  for (const model of provider.models) {
    lines.push("", `[[${name}.models]]`, `id = ${tomlString(model.id)}`);
    if (model.label !== undefined) lines.push(`label = ${tomlString(model.label)}`);
    if (model.context !== undefined) lines.push(`context = ${contextValue(model.context)}`);
    if (model.behavesAs !== undefined) lines.push(`behaves_as = ${tomlString(model.behavesAs)}`);
    if (model.description !== undefined) lines.push(`description = ${tomlString(model.description)}`);
    if (model.fast === true) lines.push("fast = true");
  }

  return `${lines.join("\n")}\n`;
}

function headerName(line: string): string | undefined {
  const path = HEADER.exec(line)?.[1];
  if (path === undefined) return undefined;
  const first = path.split(".")[0]!.trim();
  return first.startsWith('"') && first.endsWith('"') ? first.slice(1, -1) : first;
}

export function providerLine(text: string, name: string): number | undefined {
  const index = text.split("\n").findIndex((line) => headerName(line) === name);
  return index === -1 ? undefined : index + 1;
}

export function appendProvider(text: string, block: string): string {
  const stanza = block.replace(/\s+$/, "");
  const existing = text.replace(/\s+$/, "");
  return existing === ""
    ? `${FILE_HEADER}\n\n${stanza}\n`
    : `${existing}\n\n${stanza}\n`;
}

export function replaceProvider(text: string, name: string, block: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => headerName(line) === name);
  if (start === -1) return appendProvider(text, block);

  // The stanza runs until a table belonging to something else starts.
  let end = start + 1;
  while (end < lines.length) {
    const table = headerName(lines[end]!);
    if (table !== undefined && table !== name) break;
    end++;
  }

  const tail = lines.slice(end);
  const joined = [...lines.slice(0, start), ...block.replace(/\s+$/, "").split("\n")];
  if (tail.length > 0) {
    if (tail[0]!.trim() !== "") joined.push("");
    joined.push(...tail);
  }

  return `${joined.join("\n").replace(/\s+$/, "")}\n`;
}

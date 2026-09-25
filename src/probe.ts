import type { ModelConfig, ProviderConfig } from "./config.ts";

const TIMEOUT_MS = 30_000;

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

function reason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? "";
  } catch {
    return "";
  }
}

// Answers "are the key and endpoint good", which is a narrower question than "does a
// session work", and the narrower one is what a setup step can diagnose. The suffix
// the launcher adds to a model id is a client side planning hint, so it is left off.
export async function probeGateway(
  provider: ProviderConfig,
  model: ModelConfig,
  key: string,
): Promise<ProbeOutcome> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/messages`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 16,
        messages: [{ role: "user", content: "Say ok." }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const cause = (error as Error).cause;
    const detail = cause instanceof Error ? cause.message : (error as Error).message;
    return { ok: false, detail: `could not reach ${url}: ${detail}` };
  }

  if (response.ok) {
    return { ok: true, detail: `${model.id} answered` };
  }

  const body = await response.text().catch(() => "");
  const detail = reason(body);
  const status = response.statusText === "" ? `${response.status}` : `${response.status} ${response.statusText}`;
  return { ok: false, detail: `${status}${detail === "" ? "" : `: ${detail}`}` };
}

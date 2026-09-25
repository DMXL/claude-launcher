import assert from "node:assert/strict";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { ModelConfig, ProviderConfig } from "./config.ts";
import { probeGateway } from "./probe.ts";

const MODEL: ModelConfig = { id: "deepseek-flash", context: 1024 * 1024, behavesAs: "claude-opus-4-7" };

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  model?: string;
}

async function against(
  handler: (response: ServerResponse) => void,
  run: (baseUrl: string, seen: Seen) => Promise<void>,
): Promise<void> {
  const seen: Seen = {};
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.method = request.method;
    seen.url = request.url;
    seen.authorization = request.headers.authorization;
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.model = (JSON.parse(body) as { model?: string }).model;
      handler(response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function provider(baseUrl: string): ProviderConfig {
  return { baseUrl, models: [MODEL], defaultModel: MODEL.id, fastModel: MODEL.id };
}

describe("probeGateway", () => {
  it("reports success on a 200", async () => {
    await against(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
      },
      async (baseUrl) => {
        const outcome = await probeGateway(provider(baseUrl), MODEL, "sk-test");
        assert.equal(outcome.ok, true);
        assert.equal(outcome.detail, "deepseek-flash answered");
      },
    );
  });

  it("posts to /v1/messages with the bearer token", async () => {
    await against(
      (response) => {
        response.writeHead(200);
        response.end("{}");
      },
      async (baseUrl, seen) => {
        await probeGateway(provider(baseUrl), MODEL, "sk-test");
        assert.equal(seen.method, "POST");
        assert.equal(seen.url, "/v1/messages");
        assert.equal(seen.authorization, "Bearer sk-test");
      },
    );
  });

  it("does not send the planning suffix the launcher adds", async () => {
    await against(
      (response) => {
        response.writeHead(200);
        response.end("{}");
      },
      async (baseUrl, seen) => {
        await probeGateway(provider(baseUrl), MODEL, "sk-test");
        assert.equal(seen.model, "deepseek-flash");
      },
    );
  });

  it("tolerates a trailing slash on the base url", async () => {
    await against(
      (response) => {
        response.writeHead(200);
        response.end("{}");
      },
      async (baseUrl, seen) => {
        await probeGateway(provider(`${baseUrl}/`), MODEL, "sk-test");
        assert.equal(seen.url, "/v1/messages");
      },
    );
  });

  it("reports the gateway's own reason for a rejection", async () => {
    await against(
      (response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "authentication_error", message: "invalid api key" } }));
      },
      async (baseUrl) => {
        const outcome = await probeGateway(provider(baseUrl), MODEL, "bad");
        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /401/);
        assert.match(outcome.detail, /invalid api key/);
        // A gateway that sends no reason phrase must not leave a dangling separator.
        assert.ok(!outcome.detail.includes(" :"));
      },
    );
  });

  it("still reports the status when the body is not the usual shape", async () => {
    await against(
      (response) => {
        response.writeHead(500);
        response.end("<html>gateway lost</html>");
      },
      async (baseUrl) => {
        const outcome = await probeGateway(provider(baseUrl), MODEL, "sk-test");
        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /500/);
      },
    );
  });

  it("reports an unreachable gateway rather than throwing", async () => {
    // Port 1 on loopback is reserved and never listening.
    const outcome = await probeGateway(provider("http://127.0.0.1:1"), MODEL, "sk-test");
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /could not reach http:\/\/127\.0\.0\.1:1\/v1\/messages/);
  });
});

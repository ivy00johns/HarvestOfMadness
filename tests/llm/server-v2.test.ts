/**
 * v2 proxy routes — POST /api/embeddings + tiered routing on
 * POST /api/agent/complete (contracts/openapi.yaml 2.0.0).
 *
 * The Express app is mounted in-process via createApp() on an ephemeral
 * port; the FreeLLMAPI upstream is a local node:http stub, also on an
 * ephemeral port. Both are closed in afterEach. No real services touched.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../server/app";
import { createBudget, type Budget } from "../../server/llm/budget";
import {
  __resetBreakerForTests,
  __setBreakerNowForTests,
  type UpstreamConfig,
} from "../../server/llm/upstream";

const KEY = "freellmapi-TestKey1234567890abcdef";

type Json = Record<string, unknown>;

interface UpstreamSeen {
  path: string;
  auth: string | undefined;
  body: Json;
}

const openServers: http.Server[] = [];

afterEach(async () => {
  __resetBreakerForTests(); // clear any open 429 breaker + restore the real clock
  await Promise.all(
    openServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: http.Server): Promise<number> {
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Local FreeLLMAPI stub. Records requests; replies per route handler. */
async function startUpstream(
  handler: (path: string, body: Json, res: http.ServerResponse) => void,
  seen: UpstreamSeen[] = [],
): Promise<{ port: number; seen: UpstreamSeen[] }> {
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      const body = data ? (JSON.parse(data) as Json) : {};
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      handler(req.url ?? "", body, res);
    });
  });
  const port = await listen(server);
  return { port, seen };
}

function replyJson(res: http.ServerResponse, status: number, body: unknown, headers: Json = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...(headers as object) });
  res.end(JSON.stringify(body));
}

async function startApp(
  cfgOverrides: Partial<UpstreamConfig>,
  budget: Budget = createBudget(200),
): Promise<{ base: string; budget: Budget }> {
  const cfg: UpstreamConfig = {
    baseUrl: "http://127.0.0.1:9", // unreachable unless overridden
    apiKey: KEY,
    model: "base-model",
    modelFast: "fast-model",
    modelSmart: "smart-model",
    embedModel: "embed-model",
    ...cfgOverrides,
  };
  const app = createApp(cfg, budget);
  const server = http.createServer(app);
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, budget };
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/embeddings — happy path", () => {
  it("forwards model+input to /v1/embeddings and returns {embeddings, model} from X-Routed-Via", async () => {
    const { port, seen } = await startUpstream((path, _body, res) => {
      expect(path).toBe("/v1/embeddings");
      replyJson(
        res,
        200,
        {
          model: "body-model",
          data: [
            // deliberately out of order — the proxy must sort by index
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
          ],
        },
        { "X-Routed-Via": "bge-small-en" },
      );
    });
    const { base, budget } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/embeddings", { texts: ["hello", "world"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      embeddings: [
        [1, 2],
        [3, 4],
      ],
      model: "bge-small-en",
    });

    // Wire shape to upstream: configured embed model, input = texts, bearer key.
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ model: "embed-model", input: ["hello", "world"] });
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);

    // Embeddings do NOT count toward the decision daily ceiling.
    expect(budget.decisionsToday()).toBe(0);
  });

  it("falls back to body.model when X-Routed-Via is absent", async () => {
    const { port } = await startUpstream((_path, _body, res) => {
      replyJson(res, 200, { model: "body-model", data: [{ index: 0, embedding: [0.5] }] });
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/embeddings", { texts: ["x"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("body-model");
  });
});

describe("POST /api/embeddings — 400 validation (ApiError envelope)", () => {
  const cases: Array<[string, unknown]> = [
    ["missing texts", {}],
    ["texts not an array", { texts: "hello" }],
    ["empty texts array", { texts: [] }],
    ["over 32 texts", { texts: Array.from({ length: 33 }, (_, i) => `t${i}`) }],
    ["an empty string entry", { texts: ["ok", ""] }],
    ["a non-string entry", { texts: ["ok", 42] }],
    ["an oversized (>2000 chars) entry", { texts: ["ok", "x".repeat(2001)] }],
    ["a non-object body", [1, 2, 3]],
  ];

  for (const [name, body] of cases) {
    it(`rejects ${name} with 400 invalid_request_error, without calling upstream`, async () => {
      const { port, seen } = await startUpstream((_p, _b, res) => replyJson(res, 200, {}));
      const { base, budget } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

      const res = await post(base, "/api/embeddings", body);
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: { message: string; type: string } };
      expect(err.error.type).toBe("invalid_request_error");
      expect(typeof err.error.message).toBe("string");
      expect(err.error.message.length).toBeGreaterThan(0);
      expect(seen).toHaveLength(0);
      expect(budget.decisionsToday()).toBe(0);
    });
  }

  it("accepts exactly 32 texts (boundary)", async () => {
    const { port } = await startUpstream((_path, body, res) => {
      const input = (body as { input: string[] }).input;
      replyJson(res, 200, {
        model: "m",
        data: input.map((_t, index) => ({ index, embedding: [index] })),
      });
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/embeddings", {
      texts: Array.from({ length: 32 }, (_, i) => `t${i}`),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { embeddings: number[][] }).embeddings).toHaveLength(32);
  });
});

describe("POST /api/embeddings — upstream + auth failures", () => {
  it("maps upstream 5xx to 502 upstream_error with a sanitized message", async () => {
    const { port } = await startUpstream((_path, _body, res) => {
      replyJson(res, 500, {
        error: { message: `boom at http://127.0.0.1:3001/v1 with key ${KEY}`, type: "server_error" },
      });
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/embeddings", { texts: ["x"] });
    expect(res.status).toBe(502);
    const err = (await res.json()) as { error: { message: string; type: string } };
    expect(err.error.type).toBe("upstream_error");
    expect(err.error.message).not.toContain(KEY); // key redacted
    expect(err.error.message).not.toContain("127.0.0.1"); // URL redacted
  });

  it("maps a network failure (closed port) to 502 upstream_error", async () => {
    const { base } = await startApp({ baseUrl: "http://127.0.0.1:9" });
    const res = await post(base, "/api/embeddings", { texts: ["x"] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("upstream_error");
  });

  it("maps upstream 401/429 to authentication_error/rate_limit_error", async () => {
    let status = 401;
    const { port } = await startUpstream((_path, _body, res) => {
      replyJson(res, status, { error: { message: "denied", type: "x" } });
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const unauth = await post(base, "/api/embeddings", { texts: ["x"] });
    expect(unauth.status).toBe(401);
    expect(((await unauth.json()) as { error: { type: string } }).error.type).toBe(
      "authentication_error",
    );

    status = 429;
    const limited = await post(base, "/api/embeddings", { texts: ["x"] });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { type: string } }).error.type).toBe(
      "rate_limit_error",
    );
  });

  it("returns 401 authentication_error without calling upstream when the key is unconfigured", async () => {
    const { port, seen } = await startUpstream((_p, _b, res) => replyJson(res, 200, {}));
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "" });

    const res = await post(base, "/api/embeddings", { texts: ["x"] });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "authentication_error",
    );
    expect(seen).toHaveLength(0);
  });

  it("maps a malformed upstream body (missing data array) to 502", async () => {
    const { port } = await startUpstream((_path, _body, res) => {
      replyJson(res, 200, { model: "m" }); // no data
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/embeddings", { texts: ["x"] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("upstream_error");
  });
});

describe("POST /api/agent/complete — v2 tier mapping", () => {
  const COMPLETE = { agentId: "dora", system: "sys", user: "obs" };

  function chatUpstream() {
    return startUpstream((path, _body, res) => {
      expect(path).toBe("/v1/chat/completions");
      replyJson(
        res,
        200,
        {
          model: "served-model",
          choices: [{ message: { content: '{"action":"WAIT"}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        },
        { "X-Routed-Via": "served-model" },
      );
    });
  }

  it("omitted tier uses the v1 base model; fast/smart map to their env models", async () => {
    const { port, seen } = await chatUpstream();
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(200);
    expect((await post(base, "/api/agent/complete", { ...COMPLETE, tier: "fast" })).status).toBe(200);
    expect((await post(base, "/api/agent/complete", { ...COMPLETE, tier: "smart" })).status).toBe(200);

    expect(seen.map((s) => s.body.model)).toEqual(["base-model", "fast-model", "smart-model"]);
  });

  it("tiers fall back to the base model when the tier env vars are unset", async () => {
    const { port, seen } = await chatUpstream();
    const { base } = await startApp({
      baseUrl: `http://127.0.0.1:${port}`,
      modelFast: undefined,
      modelSmart: undefined,
    });

    await post(base, "/api/agent/complete", { ...COMPLETE, tier: "fast" });
    await post(base, "/api/agent/complete", { ...COMPLETE, tier: "smart" });
    expect(seen.map((s) => s.body.model)).toEqual(["base-model", "base-model"]);
  });

  it("rejects an invalid tier with 400 invalid_request_error, consuming no budget", async () => {
    const { port, seen } = await chatUpstream();
    const budget = createBudget(5);
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` }, budget);

    const res = await post(base, "/api/agent/complete", { ...COMPLETE, tier: "turbo" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "invalid_request_error",
    );
    expect(seen).toHaveLength(0);
    expect(budget.decisionsToday()).toBe(0);
  });

  it("tiered decisions still consume the daily ceiling; embeddings never do", async () => {
    const { port } = await startUpstream((path, body, res) => {
      if (path === "/v1/embeddings") {
        const input = (body as { input: string[] }).input;
        replyJson(res, 200, {
          model: "m",
          data: input.map((_t, index) => ({ index, embedding: [1] })),
        });
        return;
      }
      replyJson(res, 200, {
        model: "m",
        choices: [{ message: { content: "ok" } }],
      });
    });
    const budget = createBudget(2);
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` }, budget);

    expect((await post(base, "/api/embeddings", { texts: ["a"] })).status).toBe(200);
    expect((await post(base, "/api/agent/complete", { ...COMPLETE, tier: "fast" })).status).toBe(200);
    expect((await post(base, "/api/embeddings", { texts: ["b"] })).status).toBe(200);
    expect(budget.decisionsToday()).toBe(1);

    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(200);
    // Ceiling reached — decisions 429, embeddings still fine.
    const blocked = await post(base, "/api/agent/complete", COMPLETE);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { type: string } }).error.type).toBe(
      "budget_exceeded",
    );
    expect((await post(base, "/api/embeddings", { texts: ["c"] })).status).toBe(200);
  });
});

describe("POST /api/agent/complete — auto retry resilience", () => {
  const COMPLETE = { agentId: "dora", system: "sys", user: "obs" };

  it("recovers a bounceable 5xx by retrying on the auto lane (re-route)", async () => {
    let n = 0;
    const { port, seen } = await startUpstream((_path, _body, res) => {
      n += 1;
      if (n === 1) {
        replyJson(res, 500, { error: { message: "provider overloaded", type: "server_error" } });
        return;
      }
      replyJson(
        res,
        200,
        { model: "served", choices: [{ message: { content: '{"action":"WAIT"}' } }] },
        { "X-Routed-Via": "served" },
      );
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/agent/complete", COMPLETE);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2); // home (base-model) + one auto retry
    expect(seen[0].body.model).toBe("base-model");
    expect(seen[1].body.model).toBe("auto"); // retry re-routes via auto
    const body = (await res.json()) as { bouncedFrom?: string; bouncedTo?: string };
    expect(body.bouncedFrom).toBe("base-model");
    expect(body.bouncedTo).toBe("served");
  });

  it("retries even when the home model is already auto (auto re-routes per call)", async () => {
    let n = 0;
    const { port, seen } = await startUpstream((_path, _body, res) => {
      n += 1;
      if (n === 1) {
        replyJson(res, 503, { error: { message: "down", type: "server_error" } });
        return;
      }
      replyJson(res, 200, { model: "served", choices: [{ message: { content: "ok" } }] });
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}`, model: "auto" });

    const res = await post(base, "/api/agent/complete", COMPLETE);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2); // previously this propagated the 503 with no retry
  });

  it("does not retry a terminal 401 auth failure", async () => {
    const { port, seen } = await startUpstream((_p, _b, res) =>
      replyJson(res, 401, { error: { message: "denied", type: "x" } }),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/agent/complete", COMPLETE);
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it("gives up with 502 after exhausting the bounded auto retries", async () => {
    const { port, seen } = await startUpstream((_p, _b, res) =>
      replyJson(res, 503, { error: { message: "still down", type: "server_error" } }),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/agent/complete", COMPLETE);
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(3); // home + 2 auto retries
  });
});

describe("POST /api/agent/complete — 429 is NOT bounceable (Fix A)", () => {
  const COMPLETE = { agentId: "dora", system: "sys", user: "obs" };

  it("propagates a 429 immediately with exactly ONE upstream POST (no auto-retry storm)", async () => {
    const { port, seen } = await startUpstream((_p, _b, res) =>
      replyJson(res, 429, { error: { message: "rate limited", type: "rate_limit_error" } }),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/agent/complete", COMPLETE);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("rate_limit_error");
    // Contrast the 5xx case (which bounces to 3): a 429 is a GLOBAL gateway
    // window, so re-routing cannot escape it — fire once, propagate.
    expect(seen).toHaveLength(1);
  });
});

describe("Reset-honoring 429 circuit breaker (Fix B)", () => {
  const COMPLETE = { agentId: "dora", system: "sys", user: "obs" };

  /** A stub whose 429/200 reply + Retry-After is controlled per call. */
  function flakyUpstream(state: { status: number; retryAfter?: string }) {
    return startUpstream((path, body, res) => {
      if (state.status === 429) {
        const headers = state.retryAfter ? { "Retry-After": state.retryAfter } : {};
        replyJson(res, 429, { error: { message: "limited", type: "rate_limit_error" } }, headers);
        return;
      }
      if (path === "/v1/embeddings") {
        const input = (body as { input: string[] }).input;
        replyJson(res, 200, { model: "m", data: input.map((_t, index) => ({ index, embedding: [1] })) });
        return;
      }
      replyJson(
        res,
        200,
        { model: "served", choices: [{ message: { content: '{"action":"WAIT"}' } }] },
        { "X-Routed-Via": "served" },
      );
    });
  }

  it("opens on a 429+Retry-After, short-circuits BOTH forwarders, then closes on first success", async () => {
    let nowMs = 1_000_000;
    __setBreakerNowForTests(() => nowMs);

    const state = { status: 429, retryAfter: "1" }; // 1s window
    const { port, seen } = await flakyUpstream(state);
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    // First request hits upstream, gets 429, opens the breaker.
    const first = await post(base, "/api/agent/complete", COMPLETE);
    expect(first.status).toBe(429);
    expect(seen).toHaveLength(1);

    // While open: 5 more requests across BOTH forwarders short-circuit — 0 new
    // upstream calls, all return 429 fast.
    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(429);
    expect((await post(base, "/api/agent/complete", { ...COMPLETE, tier: "fast" })).status).toBe(429);
    expect((await post(base, "/api/embeddings", { texts: ["a"] })).status).toBe(429);
    expect((await post(base, "/api/embeddings", { texts: ["b"] })).status).toBe(429);
    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(429);
    expect(seen).toHaveLength(1); // breaker absorbed every one

    // Advance past the 1s window AND flip the stub to healthy.
    nowMs += 1_500;
    state.status = 200;

    const recovered = await post(base, "/api/agent/complete", COMPLETE);
    expect(recovered.status).toBe(200);
    expect(seen).toHaveLength(2); // exactly one new upstream call

    // Breaker is closed — subsequent calls flow normally to upstream again.
    expect((await post(base, "/api/embeddings", { texts: ["c"] })).status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  it("honors X-RateLimit-Reset (epoch seconds) and clamps an absurd window to <=60s", async () => {
    let nowMs = 5_000_000; // 5_000s epoch
    __setBreakerNowForTests(() => nowMs);

    // Reset 9999s in the future — must be clamped to a 60s max.
    const resetEpochSec = Math.floor(nowMs / 1000) + 9_999;
    const { port, seen } = await startUpstream((_p, _b, res) =>
      replyJson(
        res,
        429,
        { error: { message: "limited", type: "rate_limit_error" } },
        { "X-RateLimit-Reset": String(resetEpochSec) },
      ),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(429);
    expect(seen).toHaveLength(1);

    // Still open at +30s (< clamped 60s) — short-circuited, no new call.
    nowMs += 30_000;
    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(429);
    expect(seen).toHaveLength(1);

    // Past the 60s clamp (+61s total) — breaker reopens the lane to upstream.
    nowMs += 31_000;
    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(429);
    expect(seen).toHaveLength(2); // window had been clamped to 60s, not 9999s
  });

  it("does NOT open on 401/5xx — only 429 trips the breaker", async () => {
    __setBreakerNowForTests(() => 2_000_000);

    // 503 storm: bounces (home + 2 retries = 3) but never opens the breaker,
    // so a following request still reaches upstream.
    const { port, seen } = await startUpstream((_p, _b, res) =>
      replyJson(res, 503, { error: { message: "down", type: "server_error" } }),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    expect((await post(base, "/api/agent/complete", COMPLETE)).status).toBe(502);
    expect(seen).toHaveLength(3);
    expect((await post(base, "/api/embeddings", { texts: ["x"] })).status).toBe(502);
    expect(seen).toHaveLength(4); // not short-circuited — breaker stayed closed
  });
});

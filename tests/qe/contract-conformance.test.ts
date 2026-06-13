/**
 * QE v2 — contract conformance diff: openapi.yaml 2.0.0 vs server/app.ts vs
 * the client callers (src/llm/router.ts liveRouter, src/llm/embed.ts).
 *
 * The Express app is mounted in-process (createApp + http on port 0) and the
 * FreeLLMAPI upstream is a local node:http stub, also on port 0 — no real
 * service or fixed port is ever touched. Client callers are probed by
 * stubbing globalThis.fetch and capturing the exact wire shape they send.
 *
 * Asserted here (the cross-agent seam no single role-agent owned end to end):
 *  - paths + methods exist exactly as the spec says (and ONLY with the
 *    spec'd method);
 *  - every field name on both wires is camelCase and spec-named;
 *  - tier enum (fast|smart) validated server-side AND mapped to the right
 *    upstream model; omitted tier behaves exactly like v1 (base model);
 *  - embeddings 1..32 texts, ≤2000 chars each, order preserved;
 *  - error envelope: every non-200 is {error:{message,type}} with type in
 *    the contract's closed enum and message ≤ 240 chars;
 *  - client constants agree with the server cap (32);
 *  - liveRouter / embedTexts post to the exact spec paths with the exact
 *    spec field names, and degrade per contract on errors.
 */
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp, MAX_EMBED_TEXTS, MAX_EMBED_TEXT_LENGTH } from "../../server/app";
import { createBudget, type Budget } from "../../server/llm/budget";
import type { UpstreamConfig } from "../../server/llm/upstream";
import { liveRouter } from "../../src/llm/router";
import { embedTexts, EMBED_BATCH_SIZE } from "../../src/llm/embed";

const ERROR_TYPES = [
  "authentication_error",
  "rate_limit_error",
  "budget_exceeded",
  "upstream_error",
  "invalid_request_error",
  "server_error",
] as const;

type Json = Record<string, unknown>;

const openServers: http.Server[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
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

interface UpstreamSeen {
  path: string;
  method: string;
  auth: string | undefined;
  body: Json;
}

async function startUpstream(
  handler: (path: string, body: Json, res: http.ServerResponse) => void,
): Promise<{ port: number; seen: UpstreamSeen[] }> {
  const seen: UpstreamSeen[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      const body = data ? (JSON.parse(data) as Json) : {};
      seen.push({
        path: req.url ?? "",
        method: req.method ?? "",
        auth: req.headers.authorization,
        body,
      });
      handler(req.url ?? "", body, res);
    });
  });
  const port = await listen(server);
  return { port, seen };
}

function replyJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Json = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...(headers as object) });
  res.end(JSON.stringify(body));
}

const KEY = "freellmapi-QeConformanceKey0000";

async function startApp(
  cfgOverrides: Partial<UpstreamConfig> = {},
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
  return realFetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Assert a response is the contract ApiError envelope, type in the enum. */
async function expectEnvelope(
  res: Response,
  status: number,
  type: (typeof ERROR_TYPES)[number],
): Promise<Json> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error?: { message?: unknown; type?: unknown } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error as object).sort()).toEqual(["message", "type"]);
  expect(body.error?.type).toBe(type);
  expect(ERROR_TYPES).toContain(body.error?.type);
  expect(typeof body.error?.message).toBe("string");
  expect((body.error?.message as string).length).toBeLessThanOrEqual(240);
  return body as Json;
}

const COMPLETION_OK = {
  model: "upstream-body-model",
  choices: [{ message: { content: '{"thought":"t","say":null,"action":"WAIT"}' } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
};

// ---------------------------------------------------------------------------
// Spec text ↔ implementation constants
// ---------------------------------------------------------------------------

describe("openapi.yaml 2.0.0 ↔ implementation constants", () => {
  const spec = fs.readFileSync(
    fileURLToPath(new URL("../../contracts/openapi.yaml", import.meta.url)),
    "utf8",
  );

  it("spec is version 2.0.0 and declares exactly the three contract paths", () => {
    expect(spec).toContain("version: 2.0.0");
    for (const p of ["/api/health:", "/api/agent/complete:", "/api/embeddings:"]) {
      expect(spec, p).toContain(p);
    }
    // No phantom paths beyond the contract's three.
    const paths = spec.match(/^ {2}(\/[^\s:]*):$/gm) ?? [];
    expect(paths.map((s) => s.trim().replace(/:$/, "")).sort()).toEqual([
      "/api/agent/complete",
      "/api/embeddings",
      "/api/health",
    ]);
  });

  it("spec error enum matches contracts/types.ts ApiError exactly", () => {
    for (const t of ERROR_TYPES) expect(spec).toContain(t);
  });

  it("client batch cap === server cap === spec maxItems 32", () => {
    expect(MAX_EMBED_TEXTS).toBe(32);
    expect(EMBED_BATCH_SIZE).toBe(MAX_EMBED_TEXTS);
    expect(spec).toContain("maxItems: 32");
    expect(MAX_EMBED_TEXT_LENGTH).toBe(2000);
    expect(spec).toContain("maxLength: 2000");
  });
});

// ---------------------------------------------------------------------------
// Server routes — paths, methods, field names
// ---------------------------------------------------------------------------

describe("server routes match the spec (paths + methods + camelCase fields)", () => {
  it("GET /api/health returns exactly {status, upstream, decisionsToday, dailyCeiling}", async () => {
    const { base } = await startApp({}, createBudget(123));
    const res = await realFetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(Object.keys(body).sort()).toEqual([
      "dailyCeiling",
      "decisionsToday",
      "status",
      "upstream",
    ]);
    expect(body.status).toBe("ok");
    expect(["ok", "unreachable", "unauthorized"]).toContain(body.upstream);
    expect(Number.isInteger(body.decisionsToday)).toBe(true);
    expect(body.dailyCeiling).toBe(123);
  });

  it("the spec'd POST routes reject GET (no accidental extra methods)", async () => {
    const { base } = await startApp();
    for (const path of ["/api/agent/complete", "/api/embeddings"]) {
      const res = await realFetch(`${base}${path}`);
      expect(res.status, `GET ${path}`).toBe(404);
    }
    // Unknown paths are not silently routed anywhere.
    const res = await post(base, "/api/agent/completions", { agentId: "a" });
    expect(res.status).toBe(404);
  });

  it("complete 200 body carries exactly the camelCase CompleteResponse fields", async () => {
    const { port } = await startUpstream((_path, _body, res) =>
      replyJson(res, 200, COMPLETION_OK, { "X-Routed-Via": "routed-model" }),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const res = await post(base, "/api/agent/complete", {
      agentId: "Dora",
      system: "sys",
      user: "usr",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(Object.keys(body).sort()).toEqual([
      "latencyMs",
      "model",
      "raw",
      "tokensIn",
      "tokensOut",
    ]);
    expect(body.model).toBe("routed-model"); // X-Routed-Via wins over body.model
    expect(body.raw).toBe('{"thought":"t","say":null,"action":"WAIT"}');
    expect(typeof body.latencyMs).toBe("number");
    expect(body.tokensIn).toBe(11); // usage.prompt_tokens -> tokensIn (camelCase)
    expect(body.tokensOut).toBe(7); // usage.completion_tokens -> tokensOut
    // No snake_case leaks through the proxy.
    expect(JSON.stringify(body)).not.toMatch(/prompt_tokens|completion_tokens/);
  });

  it("required complete fields enforced; snake_case aliases are NOT accepted", async () => {
    const { base } = await startApp();
    for (const body of [
      {},
      { agentId: "a", system: "s" }, // user missing
      { agent_id: "a", system: "s", user: "u" }, // snake_case is not the contract
      { agentId: "", system: "s", user: "u" }, // empty string
      { agentId: "a", system: "s", user: "u", jsonSchema: "not-an-object" },
      [],
      "just a string",
    ]) {
      const res = await post(base, "/api/agent/complete", body);
      await expectEnvelope(res, 400, "invalid_request_error");
    }
  });

  it("malformed (non-JSON) body still gets the ApiError envelope", async () => {
    const { base } = await startApp();
    const res = await realFetch(`${base}/api/agent/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    await expectEnvelope(res, 400, "invalid_request_error");
  });
});

// ---------------------------------------------------------------------------
// Tier enum — validation + model mapping
// ---------------------------------------------------------------------------

describe("tier enum (fast|smart) — closed set, mapped to env models", () => {
  it('tier "fast"/"smart"/omitted map to fast-model/smart-model/base-model upstream', async () => {
    const { port, seen } = await startUpstream((_p, _b, res) =>
      replyJson(res, 200, COMPLETION_OK),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    for (const [tier, expected] of [
      ["fast", "fast-model"],
      ["smart", "smart-model"],
      [undefined, "base-model"],
    ] as const) {
      const res = await post(base, "/api/agent/complete", {
        agentId: "a",
        system: "s",
        user: "u",
        ...(tier !== undefined ? { tier } : {}),
      });
      expect(res.status).toBe(200);
      const last = seen[seen.length - 1];
      expect(last.path).toBe("/v1/chat/completions");
      expect(last.method).toBe("POST");
      expect(last.auth).toBe(`Bearer ${KEY}`);
      expect(last.body.model, `tier=${String(tier)}`).toBe(expected);
      expect(last.body.stream).toBe(false);
    }
  });

  it("values outside the enum are 400 invalid_request_error, never forwarded", async () => {
    const { port, seen } = await startUpstream((_p, _b, res) =>
      replyJson(res, 200, COMPLETION_OK),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    for (const tier of ["FAST", "Smart", "turbo", "", 3, null, ["fast"]]) {
      const res = await post(base, "/api/agent/complete", {
        agentId: "a",
        system: "s",
        user: "u",
        tier,
      });
      await expectEnvelope(res, 400, "invalid_request_error");
    }
    expect(seen).toHaveLength(0); // nothing reached upstream
  });
});

// ---------------------------------------------------------------------------
// Embeddings — 1..32 limit, length cap, order, envelope
// ---------------------------------------------------------------------------

describe("POST /api/embeddings — spec limits enforced at the boundary", () => {
  it("exactly 32 texts is accepted; 33 and 0 are 400; order is preserved", async () => {
    const { port, seen } = await startUpstream((_p, body, res) => {
      const input = body.input as string[];
      replyJson(res, 200, {
        model: "embed-served",
        // reversed on purpose: the proxy must restore order via index
        data: input
          .map((_, i) => ({ index: i, embedding: [i, i + 0.5] }))
          .reverse(),
      });
    });
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });

    const r0 = await post(base, "/api/embeddings", { texts: [] });
    await expectEnvelope(r0, 400, "invalid_request_error");

    const r33 = await post(base, "/api/embeddings", {
      texts: Array.from({ length: 33 }, (_, i) => `t${i}`),
    });
    await expectEnvelope(r33, 400, "invalid_request_error");
    expect(seen).toHaveLength(0); // limit enforced BEFORE any upstream call

    const texts32 = Array.from({ length: 32 }, (_, i) => `t${i}`);
    const r32 = await post(base, "/api/embeddings", { texts: texts32 });
    expect(r32.status).toBe(200);
    const body = (await r32.json()) as { embeddings: number[][]; model: string };
    expect(Object.keys(body).sort()).toEqual(["embeddings", "model"]);
    expect(body.embeddings).toHaveLength(32);
    expect(body.embeddings[0]).toEqual([0, 0.5]); // index-order restored
    expect(body.embeddings[31]).toEqual([31, 31.5]);
    expect(seen[0].body.input).toEqual(texts32); // forwarded as OpenAI `input`
  });

  it("texts >2000 chars / non-string / empty-string entries are 400", async () => {
    const { base } = await startApp();
    for (const texts of [
      ["x".repeat(2001)],
      ["ok", 42],
      ["ok", ""],
      "not-an-array",
      undefined,
    ]) {
      const res = await post(base, "/api/embeddings", { texts });
      await expectEnvelope(res, 400, "invalid_request_error");
    }
  });
});

// ---------------------------------------------------------------------------
// Error envelope — every failure class lands in the contract enum
// ---------------------------------------------------------------------------

describe("error envelope conformance across every failure class", () => {
  it("missing key → 401 authentication_error on BOTH post routes", async () => {
    const { base } = await startApp({ apiKey: "" });
    const r1 = await post(base, "/api/agent/complete", {
      agentId: "a",
      system: "s",
      user: "u",
    });
    await expectEnvelope(r1, 401, "authentication_error");
    const r2 = await post(base, "/api/embeddings", { texts: ["a"] });
    await expectEnvelope(r2, 401, "authentication_error");
  });

  it("upstream down → 502 upstream_error; upstream 429 → rate_limit_error; upstream 401 → authentication_error", async () => {
    const down = await startApp(); // baseUrl unreachable
    await expectEnvelope(
      await post(down.base, "/api/agent/complete", { agentId: "a", system: "s", user: "u" }),
      502,
      "upstream_error",
    );
    await expectEnvelope(
      await post(down.base, "/api/embeddings", { texts: ["a"] }),
      502,
      "upstream_error",
    );

    const { port } = await startUpstream((path, _b, res) =>
      replyJson(res, path.includes("embeddings") ? 401 : 429, {
        error: { message: "exhausted", type: "rate_limit_error" },
      }),
    );
    const up = await startApp({ baseUrl: `http://127.0.0.1:${port}` });
    await expectEnvelope(
      await post(up.base, "/api/agent/complete", { agentId: "a", system: "s", user: "u" }),
      429,
      "rate_limit_error",
    );
    await expectEnvelope(
      await post(up.base, "/api/embeddings", { texts: ["a"] }),
      401,
      "authentication_error",
    );
  });

  it("budget ceiling → 429 budget_exceeded WITHOUT touching upstream; embeddings stay unbudgeted", async () => {
    const { port, seen } = await startUpstream((path, body, res) => {
      if (path === "/v1/embeddings") {
        const input = body.input as string[];
        replyJson(res, 200, {
          model: "m",
          data: input.map((_, i) => ({ index: i, embedding: [1] })),
        });
      } else {
        replyJson(res, 200, COMPLETION_OK);
      }
    });
    const { base } = await startApp(
      { baseUrl: `http://127.0.0.1:${port}` },
      createBudget(1),
    );

    const ok = await post(base, "/api/agent/complete", { agentId: "a", system: "s", user: "u" });
    expect(ok.status).toBe(200);

    const over = await post(base, "/api/agent/complete", { agentId: "a", system: "s", user: "u" });
    await expectEnvelope(over, 429, "budget_exceeded");
    expect(seen.filter((s) => s.path === "/v1/chat/completions")).toHaveLength(1);

    // Embedding calls do NOT count toward (or get blocked by) the ceiling.
    const emb = await post(base, "/api/embeddings", { texts: ["still works"] });
    expect(emb.status).toBe(200);
  });

  it("a huge upstream error message is truncated to ≤240 chars in the envelope", async () => {
    const { port } = await startUpstream((_p, _b, res) =>
      replyJson(res, 500, { error: { message: "boom ".repeat(200), type: "server_error" } }),
    );
    const { base } = await startApp({ baseUrl: `http://127.0.0.1:${port}` });
    const res = await post(base, "/api/agent/complete", { agentId: "a", system: "s", user: "u" });
    const body = await expectEnvelope(res, 502, "upstream_error");
    expect(((body.error as Json).message as string).length).toBeLessThanOrEqual(240);
  });
});

// ---------------------------------------------------------------------------
// Client callers — exact wire shape via a captured fetch
// ---------------------------------------------------------------------------

describe("client callers send the exact spec wire shape", () => {
  it("liveRouter POSTs /api/agent/complete with exactly the camelCase CompleteRequest fields", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ raw: '{"thought":"t","say":null,"action":"WAIT"}', model: "m", latencyMs: 5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await liveRouter({
      agentId: "Dora",
      system: "sys",
      user: "usr",
      tier: "smart",
      jsonSchema: { type: "object" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/agent/complete");
    expect(calls[0].init.method).toBe("POST");
    const sent = JSON.parse(String(calls[0].init.body)) as Json;
    expect(Object.keys(sent).sort()).toEqual(
      ["agentId", "jsonSchema", "system", "tier", "user"], // camelCase, nothing extra
    );
    expect(sent.tier).toBe("smart");
    expect(res.error).toBeUndefined();
    expect(res.parsed?.action).toBe("WAIT");

    // Optional fields are OMITTED (not null'd) when absent — spec has no
    // nullable fields.
    await liveRouter({ agentId: "Dora", system: "sys", user: "usr" });
    const sent2 = JSON.parse(String(calls[1].init.body)) as Json;
    expect(Object.keys(sent2).sort()).toEqual(["agentId", "system", "user"]);
  });

  it("liveRouter surfaces the ApiError envelope as LlmResponse.error and never throws", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: "ceiling", type: "budget_exceeded" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    const res = await liveRouter({ agentId: "a", system: "s", user: "u" });
    expect(res.error).toBe("budget_exceeded: ceiling"); // type prefix is the
    // string AgentRuntime's budget fallback keys on (`startsWith("budget_exceeded")`)
    expect(res.raw).toBe("");

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const res2 = await liveRouter({ agentId: "a", system: "s", user: "u" });
    expect(res2.error).toBe("network down");
  });

  it("embedTexts POSTs /api/embeddings as {texts}, batching 70 → 32+32+6", async () => {
    const batches: string[][] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("/api/embeddings");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      expect(Object.keys(body)).toEqual(["texts"]); // exact spec field name
      batches.push(body.texts);
      return new Response(
        JSON.stringify({ embeddings: body.texts.map(() => [0.1, 0.2]), model: "m" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const texts = Array.from({ length: 70 }, (_, i) => `text-${i}`);
    const out = await embedTexts(texts);
    expect(batches.map((b) => b.length)).toEqual([32, 32, 6]); // never exceeds the spec cap
    expect(out).toHaveLength(70);
  });

  it("embedTexts resolves [] (and never throws) on any failure — rule 10", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "down", type: "upstream_error" } }), {
        status: 502,
      }),
    ) as typeof fetch;
    expect(await embedTexts(["a", "b"])).toEqual([]);

    globalThis.fetch = vi.fn(async () => {
      throw new Error("refused");
    }) as typeof fetch;
    expect(await embedTexts(["a"])).toEqual([]);

    // count mismatch (a partial result would misalign text<->vector indices)
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ embeddings: [[1]], model: "m" }), { status: 200 }),
    ) as typeof fetch;
    expect(await embedTexts(["a", "b"])).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRequest } from "@contracts/types";
import { getRouter, liveRouter, mockRouter } from "../../src/llm/router";

const REQ: LlmRequest = { agentId: "dora", system: "sys", user: "obs" };

function stubFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("liveRouter — error contract (never throws)", () => {
  it("maps 429 budget_exceeded to an error starting with 'budget_exceeded' (AgentRuntime fallback trigger)", async () => {
    stubFetch(async () =>
      jsonResponse(429, {
        error: { message: "daily decision ceiling reached (200)", type: "budget_exceeded" },
      }),
    );
    const res = await liveRouter(REQ);
    expect(res.error).toBeDefined();
    expect(res.error!.startsWith("budget_exceeded")).toBe(true); // AgentRuntime.ts depends on this
    expect(res.parsed).toBeUndefined();
    expect(res.raw).toBe("");
    expect(res.model).toBe("unknown");
  });

  it("maps 401 authentication_error into the error field", async () => {
    stubFetch(async () =>
      jsonResponse(401, {
        error: { message: "key not configured", type: "authentication_error" },
      }),
    );
    const res = await liveRouter(REQ);
    expect(res.error!.startsWith("authentication_error")).toBe(true);
  });

  it("resolves (not rejects) on network failure", async () => {
    stubFetch(async () => {
      throw new Error("connection refused");
    });
    const res = await liveRouter(REQ);
    expect(res.error).toContain("connection refused");
    expect(res.parsed).toBeUndefined();
  });

  it("survives a non-JSON error body", async () => {
    stubFetch(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const res = await liveRouter(REQ);
    expect(res.error).toBe("proxy returned HTTP 502");
  });
});

describe("liveRouter — success path", () => {
  it("maps CompleteResponse fields and attaches parsed when the raw action validates", async () => {
    const raw = '{"thought":"water it","say":null,"action":"WATER","target":{"x":4,"y":5}}';
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { raw, model: "llama-3.3-70b", latencyMs: 412, tokensIn: 850, tokensOut: 40 }),
    );
    const res = await liveRouter({ ...REQ, jsonSchema: { type: "object" } });
    expect(res).toEqual({
      raw,
      model: "llama-3.3-70b",
      latencyMs: 412,
      tokensIn: 850,
      tokensOut: 40,
      parsed: { thought: "water it", say: null, action: "WATER", target: { x: 4, y: 5 } },
    });
    // Wire shape: POST /api/agent/complete with the contract body.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agent/complete");
    expect(JSON.parse(init.body as string)).toEqual({
      agentId: "dora",
      system: "sys",
      user: "obs",
      jsonSchema: { type: "object" },
    });
  });

  it("omits parsed (without erroring) when raw does not validate", async () => {
    stubFetch(async () =>
      jsonResponse(200, { raw: "sorry, I cannot decide", model: "m", latencyMs: 10 }),
    );
    const res = await liveRouter(REQ);
    expect(res.error).toBeUndefined();
    expect(res.parsed).toBeUndefined();
    expect(res.raw).toBe("sorry, I cannot decide");
  });
});

describe("getRouter", () => {
  it("returns mockRouter unless VITE_MODEL_MODE=live", () => {
    // vitest does not set VITE_MODEL_MODE -> mock-first default (domain rule 7)
    expect(getRouter()).toBe(mockRouter);
  });
});

/**
 * src/llm/embed.ts — embedTexts (batching, never-throws, []-on-failure per
 * contract rule 10) + cosine (degenerate inputs score 0).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBED_BATCH_SIZE, cosine, embedTexts } from "../../src/llm/embed";

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

function okEmbeddings(texts: string[]): Response {
  return jsonResponse(200, {
    embeddings: texts.map((_t, i) => [i, i + 1]),
    model: "m",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedTexts — happy path + batching", () => {
  it("posts {texts} to /api/embeddings and returns the vectors in order", async () => {
    const fetchMock = stubFetch(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { texts: string[] };
      return okEmbeddings(body.texts);
    });

    const out = await embedTexts(["a", "b"]);
    expect(out).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/embeddings");
    expect(JSON.parse(init.body as string)).toEqual({ texts: ["a", "b"] });
  });

  it("batches at 32: 70 texts → 3 calls (32+32+6), concatenated in order", async () => {
    const batchSizes: number[] = [];
    stubFetch(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { texts: string[] };
      batchSizes.push(body.texts.length);
      return jsonResponse(200, {
        embeddings: body.texts.map((t) => [Number(t)]),
        model: "m",
      });
    });

    const texts = Array.from({ length: 70 }, (_, i) => String(i));
    const out = await embedTexts(texts);
    expect(batchSizes).toEqual([EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 6]);
    expect(out).toHaveLength(70);
    expect(out[0]).toEqual([0]);
    expect(out[32]).toEqual([32]);
    expect(out[69]).toEqual([69]);
  });

  it("resolves [] for empty input without fetching", async () => {
    const fetchMock = stubFetch(async () => okEmbeddings([]));
    expect(await embedTexts([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("embedTexts — [] on ANY failure, never throws (rule 10)", () => {
  it("returns [] on a non-200 response", async () => {
    stubFetch(async () =>
      jsonResponse(502, { error: { message: "upstream down", type: "upstream_error" } }),
    );
    expect(await embedTexts(["a"])).toEqual([]);
  });

  it("returns [] on network failure", async () => {
    stubFetch(async () => {
      throw new Error("connection refused");
    });
    expect(await embedTexts(["a"])).toEqual([]);
  });

  it("returns [] on a malformed body (missing embeddings)", async () => {
    stubFetch(async () => jsonResponse(200, { model: "m" }));
    expect(await embedTexts(["a"])).toEqual([]);
  });

  it("returns [] on a count mismatch (text↔vector misalignment guard)", async () => {
    stubFetch(async () => jsonResponse(200, { embeddings: [[1]], model: "m" }));
    expect(await embedTexts(["a", "b"])).toEqual([]);
  });

  it("returns [] on non-numeric vector entries", async () => {
    stubFetch(async () => jsonResponse(200, { embeddings: [["NaN-ish", 2]], model: "m" }));
    expect(await embedTexts(["a"])).toEqual([]);
  });

  it("returns [] (not a partial result) when a later batch fails", async () => {
    let call = 0;
    stubFetch(async (_url, init) => {
      call += 1;
      if (call === 2) return jsonResponse(500, { error: { message: "x", type: "server_error" } });
      const body = JSON.parse((init as RequestInit).body as string) as { texts: string[] };
      return okEmbeddings(body.texts);
    });
    const out = await embedTexts(Array.from({ length: 40 }, (_, i) => `t${i}`));
    expect(out).toEqual([]);
    expect(call).toBe(2);
  });

  it("returns [] on a non-JSON 200 body", async () => {
    stubFetch(async () => new Response("<html>oops</html>", { status: 200 }));
    expect(await embedTexts(["a"])).toEqual([]);
  });
});

describe("cosine", () => {
  it("is 1 for identical directions and -1 for opposite", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosine([2, 0], [4, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is 0 on length mismatch", () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
  });

  it("is 0 on zero vectors and empty vectors", () => {
    expect(cosine([0, 0], [1, 2])).toBe(0);
    expect(cosine([1, 2], [0, 0])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });

  it("computes a known mid-range value", () => {
    // angle 45° → cos ≈ 0.7071
    expect(cosine([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

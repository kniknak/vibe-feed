import { describe, it, expect, vi, beforeEach } from "vitest";
import { cosineSimilarity, createEmbeddingRanker } from "./ranker";
import { personalize } from "./personalize";
import type { FeedItem } from "./types";

// The model is never downloaded in tests — the whole transformers module is
// mocked. `vi.hoisted` gives the (hoisted) mock factory a handle to a spy we can
// program per test: reject to exercise the fallback, resolve a fake extractor to
// exercise the cache.
const { pipelineMock } = vi.hoisted(() => ({ pipelineMock: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ pipeline: pipelineMock }));

const item = (over: Partial<FeedItem>): FeedItem => ({
  id: over.id ?? over.title ?? "x",
  title: over.title ?? "",
  link: `https://example.com/${over.id ?? "x"}`,
  content: over.content ?? "",
  publishedAt: over.publishedAt ?? 0,
  sourceId: "s",
  sourceTitle: "S",
  ...over,
});

// A stable, non-degenerate embedding derived from the text — enough to rank and
// to prove the extractor was (or wasn't) called, without a real model.
const vectorFor = (text: string): number[] => [
  text.length % 7,
  (text.length * 3) % 5,
  1,
];

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("matches a hand-computed value", () => {
    // [1,1]·[1,0] = 1; |[1,1]| = √2, |[1,0]| = 1 → 1/√2 ≈ 0.7071.
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(0.70710678);
  });

  it("is 0 when one vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("createEmbeddingRanker — fallback (AC-3.3)", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it("falls back to lexical order and reports 'lexical' when the model fails to load", async () => {
    pipelineMock.mockRejectedValue(new Error("offline"));
    const onMode = vi.fn();
    const ranker = createEmbeddingRanker(onMode);

    const items = [
      item({ id: "off", title: "gardening" }),
      item({ id: "hit", title: "WebGPU in the browser" }),
    ];
    const interests = { topics: ["webgpu"] };

    const ranked = await ranker.rank(items, interests);

    expect(ranked).toEqual(personalize(items, interests));
    expect(ranked.map((i) => i.id)).toEqual(["hit", "off"]);
    expect(onMode).toHaveBeenCalledWith("lexical");
  });
});

describe("createEmbeddingRanker — vector cache (AC-3.4)", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it("re-embeds only the query when interests change, not the items", async () => {
    const extractor = vi.fn(async (text: string) => ({
      tolist: () => [vectorFor(text)],
    }));
    pipelineMock.mockResolvedValue(extractor);

    const onMode = vi.fn();
    const ranker = createEmbeddingRanker(onMode);

    const items = [
      item({ id: "cats", title: "All about cats" }),
      item({ id: "dogs", title: "All about dogs" }),
    ];
    // Count only the calls that embedded an item (its text starts with a title),
    // ignoring the query embeddings.
    const itemEmbedCount = () =>
      extractor.mock.calls.filter(([text]) =>
        items.some((it) => text.startsWith(it.title))
      ).length;

    await ranker.rank(items, { topics: ["feline pets"] });
    expect(onMode).toHaveBeenCalledWith("semantic");
    expect(itemEmbedCount()).toBe(2); // each item embedded exactly once
    const totalAfterFirst = extractor.mock.calls.length; // 2 items + 1 query = 3

    await ranker.rank(items, { topics: ["canine pets"] });
    expect(itemEmbedCount()).toBe(2); // unchanged — items were served from cache
    expect(extractor.mock.calls.length).toBe(totalAfterFirst + 1); // only the new query
  });
});

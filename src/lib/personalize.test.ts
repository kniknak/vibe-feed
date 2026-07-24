import { describe, it, expect } from "vitest";
import { personalize, scoreItem, EMPTY_INTERESTS } from "./personalize";
import type { FeedItem } from "./types";

const item = (over: Partial<FeedItem>): FeedItem => ({
  id: over.id ?? over.title ?? "x",
  title: over.title ?? "",
  link: `https://example.com/${over.id ?? over.title ?? "x"}`,
  content: over.content ?? "",
  publishedAt: over.publishedAt ?? 0,
  sourceId: "s",
  sourceTitle: "S",
  ...over,
});

describe("scoreItem", () => {
  const interests = { topics: ["rust", "webgpu"] };

  it("scores a title match above a body-only match", () => {
    const inTitle = item({ id: "t", title: "Rust at scale", content: "" });
    const inBody = item({ id: "b", title: "Misc", content: "we tried rust" });
    expect(scoreItem(inTitle, interests)).toBeGreaterThan(
      scoreItem(inBody, interests)
    );
  });

  it("is 0 for an item with no overlap", () => {
    expect(scoreItem(item({ title: "gardening tips" }), interests)).toBe(0);
  });

  it("is 0 for empty interests (cold start)", () => {
    expect(scoreItem(item({ title: "Rust" }), EMPTY_INTERESTS)).toBe(0);
  });
});

describe("personalize", () => {
  it("returns items unchanged for empty interests (cold start)", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(personalize(items, EMPTY_INTERESTS)).toEqual(items);
  });

  it("orders matching items before non-matching ones", () => {
    const items = [
      item({ id: "off", title: "gardening" }),
      item({ id: "hit", title: "WebGPU in the browser" }),
    ];
    const ranked = personalize(items, { topics: ["webgpu"] });
    expect(ranked.map((i) => i.id)).toEqual(["hit", "off"]);
  });

  it("breaks score ties by newer-first, stably", () => {
    const items = [
      item({ id: "old", title: "rust", publishedAt: 1 }),
      item({ id: "new", title: "rust", publishedAt: 2 }),
    ];
    const ranked = personalize(items, { topics: ["rust"] });
    expect(ranked.map((i) => i.id)).toEqual(["new", "old"]);
  });
});

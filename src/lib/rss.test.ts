import { describe, it, expect } from "vitest";
import { collectSettled } from "./rss";
import type { FeedItem } from "./types";

const item = (id: string): FeedItem => ({
  id,
  title: id,
  link: `https://example.com/${id}`,
  content: "",
  publishedAt: 0,
  sourceId: "s",
  sourceTitle: "S",
});

const fulfilled = (items: FeedItem[]): PromiseFulfilledResult<FeedItem[]> => ({
  status: "fulfilled",
  value: items,
});

const rejected = (reason: unknown): PromiseRejectedResult => ({
  status: "rejected",
  reason,
});

describe("collectSettled", () => {
  it("keeps the fulfilled source's items and drops the rejected one", () => {
    const results = [
      rejected(new Error("network down")),
      fulfilled([item("a"), item("b")]),
    ];
    expect(collectSettled(results).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("returns [] when every source rejects", () => {
    const results = [rejected(new Error("x")), rejected(new Error("y"))];
    expect(collectSettled(results)).toEqual([]);
  });

  it("keeps every item in source order when all sources fulfill", () => {
    const results = [
      fulfilled([item("a"), item("b")]),
      fulfilled([item("c")]),
    ];
    expect(collectSettled(results).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

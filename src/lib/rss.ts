// Fetch and parse RSS/Atom directly in the browser.
//
// THIS IS DELIBERATELY NAIVE. Sharp edge left for you:
//   Formats. The parser below only understands RSS 2.0 (<item>). Atom feeds
//   (<entry>) parse as empty.
//
// (Per-source failure isolation — a flaky source no longer blanks the whole
// load — is handled in fetchAllFeeds / collectSettled below.)
//
// The default sources (see feeds.ts) all load with a plain fetch — local mock
// is served by the dev server, the network ones send CORS headers. If you add
// a source that doesn't (HN, Lobsters, …), a direct fetch will fail and you'll
// need a CORS proxy — that's your call (and a known tech-debt tradeoff).
//
// Change it freely. This is a starting point, not a reference.

import { FEEDS, type FeedSource } from "./feeds";
import type { FeedItem } from "./types";

async function fetchFeed(source: FeedSource): Promise<FeedItem[]> {
  const res = await fetch(source.url);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");

  // Naive: RSS 2.0 <item> only. Atom <entry> is not handled here.
  const items = Array.from(doc.querySelectorAll("item"));
  return items.map((item) => {
    const link = item.querySelector("link")?.textContent ?? "";
    // Full text: prefer content:encoded, fall back to description.
    // (getElementsByTagName handles the namespaced tag across browsers.)
    const encoded =
      item.getElementsByTagName("content:encoded")[0]?.textContent ?? "";
    const description = item.querySelector("description")?.textContent ?? "";
    return {
      id: link,
      title: item.querySelector("title")?.textContent ?? "(no title)",
      link,
      content: encoded || description,
      publishedAt: Date.parse(
        item.querySelector("pubDate")?.textContent ?? ""
      ) || 0,
      sourceId: source.id,
      sourceTitle: source.title,
    };
  });
}

// Loads all feeds. Sources are isolated: a failing feed is dropped instead of
// taking the whole load down, so one dead/flaky source can't blank the feed.
export async function fetchAllFeeds(): Promise<FeedItem[]> {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  return collectSettled(results);
}

// Gather the items from every source that resolved; drop (and warn about) the
// ones that rejected. Pure — no network, no DOM — so it can be unit-tested.
export function collectSettled(
  results: PromiseSettledResult<FeedItem[]>[]
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      console.warn("feed source failed, skipping:", result.reason);
    }
  }
  return items;
}

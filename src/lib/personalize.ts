// Personalization layer: takes the raw aggregated feed and a model of what the
// user is interested in, and returns the feed to actually show.
//
// The default `personalize()` is a deterministic lexical ranker: it scores each
// item by how strongly its title/text match the user's interest topics and
// sorts best-first. It needs no network and always works (offline-proof), so it
// doubles as the fallback for the optional embedding reranker (see ranker.ts).

import type { FeedItem } from "./types";

// A minimal interest model. Shape it however the design needs.
export interface UserInterests {
  topics: string[]; // empty by default (cold start)
}

export const EMPTY_INTERESTS: UserInterests = { topics: [] };

// Sensible cold-start interests so a first-time reader sees a personalized order
// immediately instead of a flat chronological list. The reader can edit these.
export const DEFAULT_INTERESTS: UserInterests = {
  topics: ["Web platform", "Offline-first", "AI & LLMs", "Developer tools"],
};

// Strip HTML and split into lowercased word tokens.
function tokenize(text: string): string[] {
  return text
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// How much a single item matches the interests. Higher = more relevant.
//   - a topic word in the TITLE is worth more than in the body (weight 3 vs 1);
//   - body hits are capped so a long article can't win on length alone;
//   - 0 means no overlap (cold start, or a genuinely unrelated item).
export function scoreItem(item: FeedItem, interests: UserInterests): number {
  const wanted = new Set(interests.topics.flatMap(tokenize));
  if (wanted.size === 0) return 0;

  const hits = (tokens: string[]) =>
    tokens.reduce((n, t) => (wanted.has(t) ? n + 1 : n), 0);

  const titleHits = hits(tokenize(item.title));
  const bodyHits = Math.min(hits(tokenize(item.content)), 12);
  return titleHits * 3 + bodyHits;
}

/**
 * Rank the feed for the reader's interests (deterministic, offline).
 *
 * Cold start (no topics) returns the feed unchanged — arrival order. Otherwise
 * items are sorted by `scoreItem` desc, with newer-first as the tie-breaker and
 * a stable fallback to original position so equal items don't jitter.
 */
export function personalize(
  items: FeedItem[],
  interests: UserInterests
): FeedItem[] {
  if (interests.topics.length === 0) return items;

  return items
    .map((item, index) => ({ item, index, score: scoreItem(item, interests) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.publishedAt - a.item.publishedAt ||
        a.index - b.index
    )
    .map((entry) => entry.item);
}

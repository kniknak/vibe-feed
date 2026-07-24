// The feed's ranking layer. Reordering the feed for a reader goes through this
// narrow interface, so any implementation (lexical / embeddings / remote) can
// hide behind it without touching the UI — the same shape as Summarizer.
//
// lexicalRanker is the default: the deterministic, offline `personalize()`
// scorer. It always works, needs no network and no dependency, and is the
// fallback that heavier rankers degrade to.

import { personalize, type UserInterests } from "./personalize";
import type { FeedItem } from "./types";

export interface Ranker {
  // Return the items reordered best-first for these interests.
  rank(items: FeedItem[], interests: UserInterests): Promise<FeedItem[]>;
}

// --- Lexical: the default. Deterministic, instant, offline, zero-dependency. ---
export const lexicalRanker: Ranker = {
  async rank(items, interests) {
    return personalize(items, interests);
  },
};

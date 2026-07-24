// The feed's ranking layer. Reordering the feed for a reader goes through this
// narrow interface, so any implementation (lexical / embeddings / remote) can
// hide behind it without touching the UI — the same shape as Summarizer.
//
// lexicalRanker is the default: the deterministic, offline `personalize()`
// scorer. It always works, needs no network and no dependency, and is the
// fallback that heavier rankers degrade to.

import { personalize, type UserInterests } from "./personalize";
import { isWebGPUAvailable } from "./summarizer";
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

// --- Embeddings: on-device semantic reranking. ---
// Ranks the feed by cosine similarity between a sentence embedding of the
// reader's interests and one of each article, computed entirely in the browser
// via transformers.js — WebGPU when available, WASM otherwise. The model weights
// are fetched once from the CDN and cached by the browser; every later re-rank
// reuses the loaded model and makes no network call. Anything that can go wrong
// (the dynamic import, the model download, an inference error) degrades to
// `personalize()`, so the feed is never worse than the lexical baseline.

// The embedding pipeline, narrowed to just what we call. The real pipeline
// instance is callable and returns a Tensor with `.tolist()`; keeping our own
// shape avoids depending on the library's full type surface.
type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: true }
) => Promise<{ tolist(): number[][] }>;

// Cosine similarity of two equal-length vectors, in [-1, 1]. The embeddings come
// back L2-normalized, so this is effectively a dot product, but we normalize
// here too to stay correct for arbitrary inputs. A zero-length vector scores 0.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// The text we embed for an item: its title plus a short plain-text excerpt of
// the body, capped so a long article can't dominate its own sentence embedding.
function itemText(item: FeedItem): string {
  const excerpt = item.content
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return `${item.title}. ${excerpt}`;
}

/**
 * Create a semantic reranker. Keep a single instance — its model and per-id
 * vector cache live in the closure, so re-ranks reuse both.
 *
 * `onMode` reports which path produced the order: "semantic" when the embeddings
 * ranked the feed, "lexical" when it fell back to `personalize()`. It drives the
 * header mode label.
 */
export function createEmbeddingRanker(
  onMode?: (mode: "semantic" | "lexical") => void
): Ranker {
  // Lazy, singleton model load — started on the first rank that needs it and
  // reused (or its failure remembered) forever after, so the weights download
  // at most once and a failed download degrades to lexical for the session.
  let extractorPromise: Promise<FeatureExtractor> | null = null;
  const loadExtractor = () => {
    if (!extractorPromise) {
      extractorPromise = (async () => {
        const { pipeline } = await import("@huggingface/transformers");
        const pipe = await pipeline(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2",
          { device: isWebGPUAvailable() ? "webgpu" : "wasm", dtype: "q8" }
        );
        return pipe as unknown as FeatureExtractor;
      })();
    }
    return extractorPromise;
  };

  const embed = async (extractor: FeatureExtractor, text: string) => {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return output.tolist()[0];
  };

  // item.id -> embedding. Item vectors never change, so each item is embedded
  // once; changing interests only re-embeds the query, never the corpus.
  const itemVectors = new Map<string, number[]>();

  return {
    async rank(items, interests) {
      // Cold start (or an empty feed) ranks nothing and loads no weights.
      if (interests.topics.length === 0 || items.length === 0) return items;

      try {
        const extractor = await loadExtractor();
        const queryVec = await embed(extractor, interests.topics.join(", "));

        for (const item of items) {
          if (!itemVectors.has(item.id)) {
            itemVectors.set(item.id, await embed(extractor, itemText(item)));
          }
        }

        const ranked = items
          .map((item, index) => ({
            item,
            index,
            score: cosineSimilarity(queryVec, itemVectors.get(item.id)!),
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.item.publishedAt - a.item.publishedAt ||
              a.index - b.index
          )
          .map((entry) => entry.item);

        onMode?.("semantic");
        return ranked;
      } catch {
        // Import, download, or inference failure — never worse than the baseline.
        onMode?.("lexical");
        return personalize(items, interests);
      }
    },
  };
}

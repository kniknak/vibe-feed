// The feed's ranking layer. Reordering the feed for a reader goes through this
// narrow interface, so any implementation (lexical / embeddings / remote) can
// hide behind it without touching the UI — the same shape as Summarizer.
//
// Every ranker returns scored items (a RankedItem per article), not a bare
// order, so the UI can show *why* an article is where it is — a "% match" badge
// — and so a re-rank can honestly say when it found no strong signal and fell
// back to chronological instead of faking a confident order.
//
// lexicalRanker is the default: the deterministic, offline `scoreItem` scorer.
// It always works, needs no network and no dependency, and is the fallback that
// heavier rankers degrade to.

import { scoreItem, type UserInterests } from "./personalize";
import { isWebGPUAvailable } from "./summarizer";
import type { FeedItem } from "./types";

// A scored feed item. `score` is the raw ranking signal — cosine similarity for
// the embedding ranker, the lexical match score for the lexical one. `relevance`
// is that score min-max normalized to 0–100 across THIS rank call, so the UI can
// render a comparable "% match" without knowing which ranker produced it.
export interface RankedItem {
  item: FeedItem;
  score: number;
  relevance: number;
}

export interface Ranker {
  // Return the items scored and reordered best-first for these interests.
  rank(items: FeedItem[], interests: UserInterests): Promise<RankedItem[]>;
}

// The relevance floor for the embedding ranker: below this top cosine similarity
// nothing in the feed matched the interests strongly enough to trust the order,
// so we present chronological rather than a confident-looking-but-arbitrary rank.
// Calibrated against the live feeds (evals/real-data-probe.test.ts): on real RSS
// the on-topic band is compressed (~0.15–0.29), an unrelated control tops out
// near 0.18, and a weak/no-match interest slips to ~0.20 — so 0.22 sits above
// both while a genuine topic match (~0.28+) still clears it comfortably. A
// margin-from-the-mean gate was measured and rejected: an unrelated query's
// uniformly-tiny cosines depress the batch mean and INFLATE its margin above a
// real-but-weak match, so it fails to floor the very case it must catch.
const MIN_TOP_COSINE = 0.22;

// Hybrid blend weight. The embedding ranker sorts by a min-max blend of the
// lexical match score and the cosine similarity:
//   blended = minMax(lexical) + HYBRID_LAMBDA * minMax(cosine)
// Cosine leads — it alone can surface a semantically-related item that shares no
// words with the interests — and the lexical score sharpens near-ties where an
// exact word match is the stronger signal. Tuned on the golden set
// (evals/eval-embeddings.test.ts): the aggregate nDCG@5 peaks across the ~2.5–3.5
// band, cosine-dominant with lexical as a tie-break; 3.0 is at the top of that
// plateau (aggregate 0.989 vs the 0.972 lift bar).
const HYBRID_LAMBDA = 3.0;

// Min-max normalize raw scores to a 0–100 relevance, keeping the given order.
// The best-scoring item maps to 100 and the worst to 0. When every score is
// equal (zero spread) or the batch is empty, relevance is 0 for all — there is
// no spread to be confident about.
function withRelevance(scored: { item: FeedItem; score: number }[]): RankedItem[] {
  let min = Infinity;
  let max = -Infinity;
  for (const { score } of scored) {
    if (score < min) min = score;
    if (score > max) max = score;
  }
  const range = max - min;
  return scored.map(({ item, score }) => ({
    item,
    score,
    relevance: range > 0 ? Math.round(((score - min) / range) * 100) : 0,
  }));
}

// Min-max scale a batch of scores to [0, 1] (min -> 0, max -> 1). A zero-spread
// batch maps to all zeros — there is no spread to weight. Used to put the lexical
// and cosine signals on one comparable scale before the hybrid blend.
function minMax(xs: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const range = max - min;
  return xs.map((x) => (range > 0 ? (x - min) / range : 0));
}

// Newest-first, with no relevance signal. The honest fallback when there are no
// interests or nothing matched strongly — an *explicit* chronological order, not
// an accident of tie-breaks on an all-zero score.
function chronological(items: FeedItem[]): RankedItem[] {
  return [...items]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map((item) => ({ item, score: 0, relevance: 0 }));
}

// The lexical ranking, shared by `lexicalRanker` and the embedding ranker's
// fallback path. Returns the scored order plus whether it is a real personalized
// ranking: no topics, or every item scoring zero, means chronological instead.
function rankLexical(
  items: FeedItem[],
  interests: UserInterests
): { ranked: RankedItem[]; personalized: boolean } {
  if (interests.topics.length === 0 || items.length === 0) {
    return { ranked: chronological(items), personalized: false };
  }

  const scored = items.map((item) => ({ item, score: scoreItem(item, interests) }));
  if (scored.every(({ score }) => score === 0)) {
    return { ranked: chronological(items), personalized: false };
  }

  const sorted = [...scored].sort(
    (a, b) => b.score - a.score || b.item.publishedAt - a.item.publishedAt
  );
  return { ranked: withRelevance(sorted), personalized: true };
}

// --- Lexical: the default. Deterministic, instant, offline, zero-dependency. ---
export const lexicalRanker: Ranker = {
  async rank(items, interests) {
    return rankLexical(items, interests).ranked;
  },
};

// --- Embeddings: on-device semantic reranking. ---
// Ranks the feed by cosine similarity between a sentence embedding of the
// reader's interests and one of each article, computed entirely in the browser
// via transformers.js — WebGPU when available, WASM otherwise. The model weights
// are fetched once from the CDN and cached by the browser; every later re-rank
// reuses the loaded model and makes no network call. Anything that can go wrong
// (the dynamic import, the model download, an inference error) degrades to the
// lexical ranking, so the feed is never worse than the lexical baseline.

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

// The text we embed for an item: its title (kept first, so it stays prominent in
// the sentence embedding) plus a plain-text excerpt of the body. github.blog and
// other full-content feeds ship the whole article, so we take up to ~1000 chars
// of real body signal — far more than a title alone — capped so a long article
// can't dominate the embedding purely on length.
function itemText(item: FeedItem): string {
  const body = item.content
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
  return `${item.title}. ${body}`;
}

// The ONNX execution provider to run the model on: WebGPU when the browser
// exposes it, otherwise the runtime's CPU backend. transformers.js names that
// backend differently per build — "wasm" in the browser, "cpu" under Node
// (onnxruntime-node; "wasm" is rejected there) — so the same ranker runs both in
// the browser app and in the Node eval harness that measures it against lexical.
function inferenceDevice(): "webgpu" | "wasm" | "cpu" {
  if (isWebGPUAvailable()) return "webgpu";
  return typeof window === "undefined" ? "cpu" : "wasm";
}

/**
 * Create a semantic reranker. Keep a single instance — its model and per-id
 * vector cache live in the closure, so re-ranks reuse both.
 *
 * `onMode` reports which path produced the order: "semantic" when the embeddings
 * ranked the feed, "lexical" when it fell back to the lexical ranking. It drives
 * the header mode label. `onPersonalized` reports whether the result is a real
 * personalized ranking (true) or the honest chronological fallback (false) — no
 * interests, or nothing matched above the relevance floor.
 */
export function createEmbeddingRanker(
  onMode?: (mode: "semantic" | "lexical") => void,
  onPersonalized?: (personalized: boolean) => void
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
          { device: inferenceDevice(), dtype: "q8" }
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
      // Cold start (or an empty feed): chronological, nothing to personalize,
      // and no weights are loaded.
      if (interests.topics.length === 0 || items.length === 0) {
        onPersonalized?.(false);
        return chronological(items);
      }

      try {
        const extractor = await loadExtractor();
        const queryVec = await embed(extractor, interests.topics.join(", "));

        for (const item of items) {
          if (!itemVectors.has(item.id)) {
            itemVectors.set(item.id, await embed(extractor, itemText(item)));
          }
        }

        onMode?.("semantic");

        const cosines = items.map((item) =>
          cosineSimilarity(queryVec, itemVectors.get(item.id)!)
        );

        // Relevance floor: if the best match is weak, the order would be noise —
        // present chronological and say so, instead of a confident-looking rank.
        // Gated on the RAW top cosine, before the hybrid blend below.
        const topCosine = cosines.reduce((m, c) => Math.max(m, c), -Infinity);
        if (topCosine < MIN_TOP_COSINE) {
          onPersonalized?.(false);
          return chronological(items);
        }

        // Hybrid order: blend the deterministic lexical match into the semantic
        // one. Both signals are min-max normalized so neither's raw scale
        // dominates, then blended cosine-first (HYBRID_LAMBDA-weighted) with the
        // lexical score breaking near-ties. `score` stays the raw cosine — the
        // signal the "% match" badge and the floor are expressed in — only the
        // sort key is the blend.
        const nCos = minMax(cosines);
        const nLex = minMax(items.map((item) => scoreItem(item, interests)));
        const scored = items.map((item, i) => ({
          item,
          score: cosines[i],
          blended: nLex[i] + HYBRID_LAMBDA * nCos[i],
        }));

        const sorted = [...scored].sort(
          (a, b) => b.blended - a.blended || b.item.publishedAt - a.item.publishedAt
        );
        onPersonalized?.(true);
        return withRelevance(sorted);
      } catch {
        // Import, download, or inference failure — never worse than the baseline.
        onMode?.("lexical");
        const { ranked, personalized } = rankLexical(items, interests);
        onPersonalized?.(personalized);
        return ranked;
      }
    },
  };
}

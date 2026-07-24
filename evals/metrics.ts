// Ranking-quality metrics for the eval harness. Pure, dependency-free functions
// that grade a ranked list of item ids against a graded relevance map
// (2 = highly relevant, 1 = related, 0 = off-topic). Used by eval.test.ts to
// score any Ranker on the golden set, and pinned to hand-computed numbers in
// metrics.test.ts. A missing id in the map counts as 0.

// Graded relevance labels keyed by item id. Only relevant items need appear —
// anything absent is off-topic (0).
export type Relevance = Record<string, number>;

const relOf = (rel: Relevance, id: string): number => rel[id] ?? 0;

// How many labelled items are relevant at all (gain > 0). The recall denominator.
function relevantCount(rel: Relevance): number {
  return Object.values(rel).filter((g) => g > 0).length;
}

// Standard discounted cumulative gain: each gain divided by log2(rank + 1),
// with rank 1-based (the array index i is 0-based, so log2(i + 2)).
function dcg(gains: number[]): number {
  return gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
}

// Fraction of the top-k that is relevant (gain > 0). Divides by k, so a short
// ranking is penalised for the empty slots — the conventional definition.
export function precisionAtK(ranked: string[], rel: Relevance, k: number): number {
  if (k <= 0) return 0;
  const hits = ranked.slice(0, k).filter((id) => relOf(rel, id) > 0).length;
  return hits / k;
}

// Fraction of all relevant items that made it into the top-k.
export function recallAtK(ranked: string[], rel: Relevance, k: number): number {
  const total = relevantCount(rel);
  if (total === 0) return 0;
  const hits = ranked.slice(0, k).filter((id) => relOf(rel, id) > 0).length;
  return hits / total;
}

// Normalised DCG at k: the ranking's DCG over the DCG of the ideal ordering
// (gains sorted descending). 1.0 = perfect order; graded gains reward putting
// the highly-relevant items first, not just the relevant ones.
export function ndcgAtK(ranked: string[], rel: Relevance, k: number): number {
  const gains = ranked.slice(0, k).map((id) => relOf(rel, id));
  const ideal = Object.values(rel)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idcg = dcg(ideal);
  if (idcg === 0) return 0;
  return dcg(gains) / idcg;
}

// Reciprocal rank of the first relevant item (1/rank, 0 if none). Averaging this
// across every profile in the harness gives the usual mean reciprocal rank.
export function mrr(ranked: string[], rel: Relevance): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relOf(rel, ranked[i]) > 0) return 1 / (i + 1);
  }
  return 0;
}

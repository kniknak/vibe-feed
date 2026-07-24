import { describe, it, expect, beforeAll } from "vitest";
import {
  lexicalRanker,
  createEmbeddingRanker,
  type Ranker,
} from "../src/lib/ranker";
import type { FeedItem } from "../src/lib/types";
import { precisionAtK, recallAtK, ndcgAtK, mrr, type Relevance } from "./metrics";
import dataset from "./dataset.json";

// On-demand embeddings-vs-lexical comparison (PLAN.md §3 US-3 AC-3.6). This
// downloads ~23 MB of model weights and runs on-device inference in Node, so it
// is deliberately NOT part of the fast per-push suite: a bare `vitest run`
// collects this file but the suite below is skipped. `npm run eval:embeddings`
// sets EVAL_EMBEDDINGS=1 to actually run it — the numbers land in the PR.
const ENABLED = !!process.env.EVAL_EMBEDDINGS;

// The agreed provisional lift bar: semantic must beat lexical nDCG@5 by at least
// this margin to justify shipping the model dependency. Provisional (+0.05),
// iterate later — the point is a measured bar, not a vibe.
const LIFT_BAR = 0.05;

interface Profile {
  id: string;
  topics: string[];
  relevance: Relevance;
}
interface Dataset {
  items: FeedItem[];
  profiles: Profile[];
}
const { items, profiles } = dataset as unknown as Dataset;

const K = { precision: 3, recall: 5, ndcg: 5 };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

interface Row {
  profile: string;
  precisionAt3: number;
  recallAt5: number;
  ndcgAt5: number;
  mrr: number;
}

async function scoreRanker(ranker: Ranker): Promise<Row[]> {
  const rows: Row[] = [];
  for (const profile of profiles) {
    const ranked = await ranker.rank(items, { topics: profile.topics });
    const ids = ranked.map((r) => r.item.id);
    rows.push({
      profile: profile.id,
      precisionAt3: precisionAtK(ids, profile.relevance, K.precision),
      recallAt5: recallAtK(ids, profile.relevance, K.recall),
      ndcgAt5: ndcgAtK(ids, profile.relevance, K.ndcg),
      mrr: mrr(ids, profile.relevance),
    });
  }
  return rows;
}

const aggNdcg = (rows: Row[]) => mean(rows.map((r) => r.ndcgAt5));

// Side-by-side lexical-vs-embeddings nDCG@5, per profile then aggregate — the
// table that justifies (or refutes) the model dependency.
function printComparison(lex: Row[], emb: Row[]): void {
  const cell = (n: number) => n.toFixed(3).padStart(10);
  console.log("\n=== embeddings vs lexical — nDCG@5 per profile ===");
  console.log("profile".padEnd(20) + "lexical".padStart(10) + "embeddings".padStart(12) + "Δ".padStart(10));
  for (let i = 0; i < lex.length; i++) {
    const d = emb[i].ndcgAt5 - lex[i].ndcgAt5;
    console.log(
      lex[i].profile.padEnd(20) +
        cell(lex[i].ndcgAt5) +
        cell(emb[i].ndcgAt5).padStart(12) +
        (d >= 0 ? "+" : "") + d.toFixed(3).padStart(9)
    );
  }
  const l = aggNdcg(lex);
  const e = aggNdcg(emb);
  console.log(
    "AGGREGATE (mean)".padEnd(20) +
      cell(l) +
      cell(e).padStart(12) +
      (e - l >= 0 ? "+" : "") + (e - l).toFixed(3).padStart(9)
  );
  console.log(
    `\nnDCG@5: lexical=${l.toFixed(3)}  embeddings=${e.toFixed(3)}  ` +
      `lift=${(e - l).toFixed(3)}  bar=+${LIFT_BAR.toFixed(2)}`
  );
  console.log(
    e >= l + LIFT_BAR
      ? "RESULT: PASS — embeddings clear the lift bar."
      : "RESULT: MISS — embeddings do NOT clear the lift bar (numbers above)."
  );
}

describe.skipIf(!ENABLED)(
  "embeddings vs lexical — golden set (AC-3.6, on-demand)",
  () => {
    let lexNdcg = 0;
    let embNdcg = 0;

    beforeAll(async () => {
      const lex = await scoreRanker(lexicalRanker);
      const emb = await scoreRanker(createEmbeddingRanker());
      lexNdcg = aggNdcg(lex);
      embNdcg = aggNdcg(emb);
      printComparison(lex, emb);
    }, 600_000);

    it("semantic beats lexical on nDCG@5 by the provisional lift bar", () => {
      // The measured numbers are always printed above; this asserts the bar.
      expect(embNdcg).toBeGreaterThanOrEqual(lexNdcg + LIFT_BAR);
    });
  }
);

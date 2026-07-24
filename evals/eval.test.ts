import { describe, it, expect, beforeAll } from "vitest";
import { lexicalRanker, type Ranker } from "../src/lib/ranker";
import type { FeedItem } from "../src/lib/types";
import { precisionAtK, recallAtK, ndcgAtK, mrr, type Relevance } from "./metrics";
import dataset from "./dataset.json";

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

// k values the harness reports on. precision@3 is the product bar (US-2 AC-2.4).
const K = { precision: 3, recall: 5, ndcg: 5 };

// Rankers under test. Inc 3 adds { name: "embeddings", ranker: embeddingRanker }
// to this list and its row prints next to the lexical baseline automatically,
// so the comparison that justifies the model dependency needs no new plumbing.
const RANKERS: { name: string; ranker: Ranker }[] = [
  { name: "lexical", ranker: lexicalRanker },
];

// Pass thresholds — the CI regression gate. Locked at / just below the measured
// lexical baseline so the suite is green now and turns red on a real quality
// drop. precision@3 is pinned to the product bar from US-2 AC-2.4.
const THRESHOLDS = {
  precisionAt3: 0.66,
  recallAt5: 0.8,
  ndcgAt5: 0.9,
  mrr: 0.95,
};

interface Scores {
  precisionAt3: number;
  recallAt5: number;
  ndcgAt5: number;
  mrr: number;
}
interface RankerResult {
  perProfile: { profile: string; scores: Scores }[];
  aggregate: Scores;
}

function scoreProfile(rankedIds: string[], rel: Relevance): Scores {
  return {
    precisionAt3: precisionAtK(rankedIds, rel, K.precision),
    recallAt5: recallAtK(rankedIds, rel, K.recall),
    ndcgAt5: ndcgAtK(rankedIds, rel, K.ndcg),
    mrr: mrr(rankedIds, rel),
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function evaluateRanker(ranker: Ranker): Promise<RankerResult> {
  const perProfile: { profile: string; scores: Scores }[] = [];
  for (const profile of profiles) {
    const ranked = await ranker.rank(items, { topics: profile.topics });
    perProfile.push({
      profile: profile.id,
      scores: scoreProfile(
        ranked.map((i) => i.id),
        profile.relevance
      ),
    });
  }
  const pick = (f: (s: Scores) => number) => mean(perProfile.map((r) => f(r.scores)));
  return {
    perProfile,
    aggregate: {
      precisionAt3: pick((s) => s.precisionAt3),
      recallAt5: pick((s) => s.recallAt5),
      ndcgAt5: pick((s) => s.ndcgAt5),
      mrr: pick((s) => s.mrr),
    },
  };
}

const COLS = ["P@3", "R@5", "nDCG@5", "MRR"];
const cells = (s: Scores) => [s.precisionAt3, s.recallAt5, s.ndcgAt5, s.mrr];
const row = (label: string, values: number[]) =>
  label.padEnd(20) + values.map((v) => v.toFixed(3).padStart(9)).join("");

function printReport(results: Map<string, RankerResult>) {
  for (const [name, result] of results) {
    console.log(`\n=== ranker: ${name} — per profile ===`);
    console.log("profile".padEnd(20) + COLS.map((c) => c.padStart(9)).join(""));
    for (const { profile, scores } of result.perProfile) {
      console.log(row(profile, cells(scores)));
    }
    console.log(row("AGGREGATE (mean)", cells(result.aggregate)));
  }
  console.log(`\n=== aggregate: ranker × metric ===`);
  console.log("ranker".padEnd(20) + COLS.map((c) => c.padStart(9)).join(""));
  for (const [name, result] of results) {
    console.log(row(name, cells(result.aggregate)));
  }
  console.log("");
}

describe("ranking eval — golden set", () => {
  const results = new Map<string, RankerResult>();

  beforeAll(async () => {
    for (const { name, ranker } of RANKERS) {
      results.set(name, await evaluateRanker(ranker));
    }
    printReport(results);
  });

  it("golden set is well-formed (>=30 items, >=5 profiles, labels reference real items)", () => {
    expect(items.length).toBeGreaterThanOrEqual(30);
    expect(profiles.length).toBeGreaterThanOrEqual(5);
    const ids = new Set(items.map((i) => i.id));
    expect(ids.size).toBe(items.length);
    for (const p of profiles) {
      for (const id of Object.keys(p.relevance)) {
        expect(ids.has(id)).toBe(true);
      }
    }
  });

  it("lexical baseline meets precision@3 (US-2 AC-2.4 product bar)", () => {
    expect(results.get("lexical")!.aggregate.precisionAt3).toBeGreaterThanOrEqual(
      THRESHOLDS.precisionAt3
    );
  });

  it("lexical baseline meets recall@5", () => {
    expect(results.get("lexical")!.aggregate.recallAt5).toBeGreaterThanOrEqual(
      THRESHOLDS.recallAt5
    );
  });

  it("lexical baseline meets nDCG@5", () => {
    expect(results.get("lexical")!.aggregate.ndcgAt5).toBeGreaterThanOrEqual(
      THRESHOLDS.ndcgAt5
    );
  });

  it("lexical baseline meets MRR", () => {
    expect(results.get("lexical")!.aggregate.mrr).toBeGreaterThanOrEqual(
      THRESHOLDS.mrr
    );
  });
});

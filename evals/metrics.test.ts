import { describe, it, expect } from "vitest";
import { precisionAtK, recallAtK, ndcgAtK, mrr, type Relevance } from "./metrics";

// A tiny fixture with hand-computable numbers. rel: a=2 (highly), c=1 (related),
// b/d off-topic. Ranked best-first as [a, b, c, d].
const rel: Relevance = { a: 2, b: 0, c: 1, d: 0 };
const ranked = ["a", "b", "c", "d"];

describe("precisionAtK", () => {
  it("counts relevant (gain > 0) items in the top-k over k", () => {
    expect(precisionAtK(ranked, rel, 2)).toBe(0.5); // top-2 [a,b] → 1 relevant / 2
    expect(precisionAtK(ranked, rel, 3)).toBeCloseTo(2 / 3, 10); // [a,b,c] → 2 / 3
    expect(precisionAtK(ranked, rel, 4)).toBe(0.5); // [a,b,c,d] → 2 / 4
  });

  it("is 0 for k <= 0", () => {
    expect(precisionAtK(ranked, rel, 0)).toBe(0);
  });
});

describe("recallAtK", () => {
  it("counts found relevant items over all relevant items", () => {
    expect(recallAtK(ranked, rel, 1)).toBe(0.5); // found a of {a,c}
    expect(recallAtK(ranked, rel, 3)).toBe(1); // found a and c
  });

  it("is 0 when nothing is relevant", () => {
    expect(recallAtK(ranked, { a: 0, b: 0 }, 3)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("matches a hand-computed nDCG with graded gains", () => {
    // gains at [a,b,c] = [2,0,1]; DCG = 2/log2(2) + 0 + 1/log2(4) = 2.5.
    // ideal gains [2,1]; IDCG = 2/log2(2) + 1/log2(3) = 2.6309297535714575.
    // nDCG = 2.5 / 2.6309297535714575 = 0.9502344167898356.
    expect(ndcgAtK(["a", "b", "c"], rel, 3)).toBeCloseTo(0.9502344167898356, 12);
  });

  it("is 1.0 when the ideal order is produced", () => {
    expect(ndcgAtK(["a", "c", "b"], rel, 3)).toBeCloseTo(1, 12);
  });

  it("is 0 when nothing is relevant", () => {
    expect(ndcgAtK(ranked, { a: 0 }, 3)).toBe(0);
  });
});

describe("mrr", () => {
  it("is the reciprocal rank of the first relevant item", () => {
    expect(mrr(["a", "b", "c"], rel)).toBe(1); // a is relevant at rank 1
    expect(mrr(["b", "a", "c"], rel)).toBe(0.5); // first relevant a at rank 2
    expect(mrr(["b", "d", "c", "a"], rel)).toBeCloseTo(1 / 3, 10); // c at rank 3
  });

  it("is 0 when no item is relevant", () => {
    expect(mrr(["b", "d"], rel)).toBe(0);
  });
});

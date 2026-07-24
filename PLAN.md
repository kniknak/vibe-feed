# Feed Personalization — Product Vision & Delivery Plan

## 1. Product Vision

**"A front page that's actually yours — private by construction."**

Readers drown in generic, chronological feeds. Recommendation engines that fix
that ship your behaviour to a backend. Vibe Feed's bet: **deliver relevance with
zero data egress** — the reader says what they care about, and the feed reorders
itself to put the most relevant articles first, computed **entirely in the
browser**. No server, no account, no tracking.

**Target reader:** someone who follows many sources and wants the 5 things worth
reading now, without handing their interests to a recommender.

**Three value pillars** (every increment serves at least one):

| Pillar | Promise | How we prove it |
|--------|---------|-----------------|
| **Relevant** | The articles I care about are at the top | Ranking evals (precision@k, nDCG) |
| **Private** | My interests never leave my device | Zero network at inference (Network panel) |
| **Robust** | It always works — offline, no model, dead source | Fallback + resilience tests |

**What "good" looks like (product success metrics — measured by the eval harness):**
- **Relevance:** for a reader's interest profile, ≥ 2 of their relevant articles
  appear in the **top 3** (precision@3 ≥ 0.66 on the golden set).
- **Lift:** semantic ranking **beats** lexical on nDCG@5 on the golden set — the
  measured lift is what justifies shipping the model dependency.
- **Privacy:** **0** network requests to any model/inference host on a re-rank
  after first load.
- **Robustness:** feed renders and ranks with a source down, no network, or no
  WebGPU.

These metrics are not aspirations — they are **encoded in `npm run eval`** and
gate CI (§4, Increment 2).

---

## 2. The seam (one design decision, all increments plug into it)

A narrow `Ranker` interface, mirroring the existing `Summarizer`:

```ts
interface Ranker { rank(items: FeedItem[], interests: UserInterests): Promise<FeedItem[]> }
```

Implementations swap freely without touching the UI: `lexicalRanker` (Inc 1),
`embeddingRanker` (Inc 3). The eval harness (Inc 2) scores **any** `Ranker`, so
adding a ranker automatically gets it a quality score.

---

## 3. User Stories & Verifiable Acceptance Criteria

Every AC has a **Verify** line naming the *exact* check — a test id, a command,
a Network-panel observation, or an eval metric. "Verifiable" = a reviewer can run
one thing and get pass/fail.

### US-1 — Capture interests  *(Inc 1)*
*As a reader, I tell the app what topics I care about and it remembers them.*

| AC | Criterion | **Verify** |
|----|-----------|-----------|
| 1.1 | Typing a topic + Enter/comma adds it as a removable tag chip | Manual: type `rust`↵ → chip appears · unit test `interests.addTopic` |
| 1.2 | Removing a tag re-ranks the feed | Manual: remove chip → order changes · unit test on reducer |
| 1.3 | Interests persist across reload | Manual: set → reload → chips restored · unit test `load/save` round-trips `localStorage["vibe-feed:interests"]` |
| 1.4 | Duplicate / blank / whitespace topics are rejected | unit test: `add("")`, `add("rust")`×2 → one `rust` |
| 1.5 | Cold start (no topics) → arrival order + a visible hint | Manual: fresh load shows "(none yet — cold start)" · unit test `personalize([...], EMPTY)` returns input unchanged |

### US-2 — Deterministic relevance (baseline)  *(Inc 1, scored in Inc 2)*
*As a reader, matching articles rise to the top instantly and offline.*

| AC | Criterion | **Verify** |
|----|-----------|-----------|
| 2.1 | With interests, items ordered by lexical score; title matches weighted above body | unit test: title-match item outranks body-only match |
| 2.2 | Equal scores tie-break newer-first, stable (no jitter) | unit test: equal-score items keep date order; re-run is identical |
| 2.3 | Works with **zero network, zero deps** (pure sync function) | unit test runs in Node with no fetch/model; `personalize` is synchronous |
| 2.4 | Meets the relevance bar on the golden set | eval: `precision@3 ≥ 0.66`, `nDCG@5 ≥ <baseline>` (locked in Inc 2) |

### US-3 — Semantic relevance (on-device)  *(Inc 3)*
*As a reader, related articles rank higher even without the exact words, computed on my device.*

| AC | Criterion | **Verify** |
|----|-----------|-----------|
| 3.1 | Items ordered by cosine similarity of on-device sentence embeddings | unit test `cosineSimilarity`; integration: known related item outranks lexical-miss |
| 3.2 | Weights fetched **once**; re-ranks make **no** network calls | Network panel: 2nd rank → 0 requests to model host · test asserts fetch not re-invoked |
| 3.3 | Model load failure → falls back to lexical, no error in the feed | test: mock `import()` reject → output equals `personalize()` order; UI shows no error |
| 3.4 | Item vectors cached by id; changing interests re-embeds only the query | test: change interests → item-embed call count unchanged, query-embed +1 |
| 3.5 | Uses `webgpu` when available, else `wasm` | test: device selection reads `isWebGPUAvailable()` |
| 3.6 | **Semantic beats lexical** on the golden set | eval: `nDCG@5(embeddings) ≥ nDCG@5(lexical) + 0.05` — **agreed working bar (provisional +0.05, iterate later)** |

### US-4 — Transparency & resilience  *(Inc 4)*
*As a reader, I see how the feed is ranked and trust it never breaks or blanks.*

| AC | Criterion | **Verify** |
|----|-----------|-----------|
| 4.1 | Non-blocking "Ranking…" status while scoring | Manual: status appears then clears · component test on ranking state |
| 4.2 | Header label states active mode (semantic / lexical fallback) | Manual: label reads "semantic" with model, "lexical" when forced-fail |
| 4.3 | One failing RSS source no longer blanks the feed | test: `fetchAllFeeds` with one source throwing → others' items returned (`allSettled`) |
| 4.4 | Re-ranking is async, never blocks reading/scrolling | Manual: scroll during rank stays responsive; rank runs off render path |

---

## 4. Evals — first-class scope (not an afterthought)

Ranking quality is a **product claim**, so it gets a **measurable, CI-gated
harness**. This is the backbone that makes US-2/US-3 AC verifiable.

**Golden dataset** — `evals/dataset.json`:
- A fixed corpus of ~30 realistic `FeedItem`s spanning distinct topics
  (AI/ML, web dev, security, hardware, product, …).
- ~5 **interest profiles**, each with **graded relevance labels** over the
  corpus (`2` = highly relevant, `1` = related, `0` = off-topic).
- Committed, deterministic, license-clean (authored, not scraped).

**Metrics** — `evals/metrics.ts` (pure, unit-tested):
- `precision@k`, `recall@k`, `nDCG@k`, `MRR`.

**Runner** — `npm run eval`:
- Scores **each registered `Ranker`** against every profile, prints a per-profile
  + aggregate table (ranker × metric).
- **Exits non-zero below threshold** → CI regression gate.
- Prints a **lexical-vs-embeddings comparison** once both exist (justifies the dep).

**CI split (honest about cost):**
- **Lexical eval → CI gate** on every push (pure, fast, deterministic).
- **Embeddings eval → `npm run eval:embeddings`** (downloads ~23 MB weights) runs
  locally + an **optional/nightly** job, not the per-push gate — so PRs stay fast.
  The comparison numbers are captured in the Inc 3 PR description.

---

## 5. Prioritized Increments (one PR / worktree each)

| # | Increment | Branch · worktree | Delivers | Priority | New deps |
|---|-----------|-------------------|----------|----------|----------|
| **1** | **Foundation** — interests UI + persistence + lexical ranking + `Ranker` seam | `feat/personalize/foundation` · inc1 | US-1, US-2 (functional) | **P0** | none |
| **2** | **Eval harness** — golden dataset, metrics, lexical baseline scored, CI gate | `feat/personalize/evals` · inc2 | US-2 (verified), success metrics | **P0** | none |
| **3** | **On-device embeddings** + eval comparison (prove lift) | `feat/personalize/embeddings` · inc3 | US-3 | **P1** | `@huggingface/transformers` |
| **4** | **Resilience & transparency** | `feat/personalize/resilience` · inc4 | US-4 | **P2** | none |

**Why this order:** build the feature (1), then the **measuring stick** (2), so
embeddings (3) must *prove* they beat the baseline the stick recorded — not just
"feel smarter". Resilience/UX (4) hardens last.

### Definition of Done — every increment
Its AC pass by their **Verify** method · `npm run build` (tsc) green ·
`npm test` green · (2+) `npm run eval` meets threshold · `npm run dev` smoke-check ·
one squashed commit · PR to `main`. **Merge is human.**

### Inc dependency & sequencing
Strictly **1 → 2 → 3 → 4**. Worktrees pre-cut off `main`; each rebases onto
`main` after its predecessor merges.

---

## 6. Out of scope (named, not silently dropped)
- **Remote LLM rerank (Gemini/etc.)** — violates FE-only privacy pillar. Dropped.
- **Implicit feedback** (learn from clicks/likes) — future increment; would extend
  the interest model + evals with an interaction-driven profile.
- **Dedup / Atom-feed parser** — scaffold tech-debt, orthogonal to personalization.
- **Relevance *filtering*** (hide below a threshold) vs pure ranking — future toggle.

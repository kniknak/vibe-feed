import { describe, it, expect, beforeAll } from "vitest";
import {
  createEmbeddingRanker,
  cosineSimilarity,
  type RankedItem,
} from "../src/lib/ranker";
import type { FeedItem } from "../src/lib/types";

// REAL-DATA ranking-quality probe (inc6). Fetches the LIVE feeds and runs the
// CURRENT shipping ranker (createEmbeddingRanker — the app's active ranker, see
// App.tsx) over a fixed set of interest profiles, then reports whether the order
// is genuinely on-topic, whether an unrelated profile correctly falls to the
// chronological FLOOR (personalized=false) instead of faking a confident rank,
// and whether relevant profiles' top similarity clearly separates from the
// unrelated control.
//
// This is a live-network + on-device-inference probe: it downloads ~23 MB of
// MiniLM weights and fetches two real RSS feeds, so it is intentionally slow and
// NOT part of the fast per-push suite. Run it directly:
//   npx vitest run evals/real-data-probe.test.ts

const LIVE_FEEDS = [
  { id: "github", title: "The GitHub Blog", url: "https://github.blog/feed/" },
  { id: "devto", title: "DEV Community", url: "https://dev.to/feed" },
];

// The relevance floor the embedding ranker uses (ranker.ts MIN_TOP_COSINE): a top
// cosine below this means nothing matched strongly enough to trust the order, so
// the ranker presents chronological and reports personalized=false. Mirrored here
// only to annotate the report — the authoritative decision comes from the ranker.
// Raised to 0.22 (from 0.20) after this probe measured the real band: an
// unrelated control tops out ~0.18 and a weak/no-match interest slips to ~0.20,
// both of which must floor, while a genuine topic clears ~0.28+.
const MIN_TOP_COSINE = 0.22;

// The probe's profiles: cold-start, three on-topic dev interests, and an
// off-topic control that should NOT match a software-engineering feed.
const PROFILES: { id: string; topics: string[] }[] = [
  { id: "cold-start", topics: [] },
  { id: "Rust", topics: ["Rust"] },
  { id: "Security", topics: ["Security"] },
  { id: "Databases", topics: ["Databases"] },
  { id: "unrelated", topics: ["cooking recipes", "gardening"] },
];

// Guaranteed-on-topic synthetic items, one per personalizable profile whose live
// coverage is unreliable (Rust, Databases — Security is a feed staple and always
// present). Injected before ranking so "an on-topic article ranks top-3 and
// personalizes" tests RANKER BEHAVIOR, not the day's RSS editorial luck: a real
// snapshot may carry no Rust/DB article at all, in which case the ranker HONESTLY
// floors (correct), and no ranker tuning can conjure content that isn't there.
// The unrelated profile gets no synthetic match, so it must still floor.
const SYNTHETIC: Record<string, FeedItem> = {
  Rust: {
    id: "synthetic:rust",
    title: "Rust 2024: ownership, the borrow checker, cargo, crates and tokio",
    link: "https://example.test/rust-2024",
    content:
      "Rust is a systems programming language focused on memory safety without a garbage collector. Its ownership model and borrow checker enforce lifetimes at compile time, cargo builds crates pulled from the registry, and the tokio runtime powers async I/O.",
    publishedAt: Date.now(),
    sourceId: "synthetic",
    sourceTitle: "Synthetic",
  },
  Databases: {
    id: "synthetic:databases",
    title: "Databases in 2024: SQL, Postgres, indexes, query planning and transactions",
    link: "https://example.test/databases-2024",
    content:
      "A database stores structured data queried with SQL. Postgres and MySQL are relational engines where indexes speed up queries, the query planner picks an execution plan, transactions give ACID guarantees, and schemas model tables and their relations.",
    publishedAt: Date.now(),
    sourceId: "synthetic",
    sourceTitle: "Synthetic",
  },
};

// --- Minimal RSS 2.0 parse (Node has no DOMParser). Mirrors rss.ts semantics:
// title, link, content:encoded || description, pubDate; id = link. ---
function stripCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
}
function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  return m ? stripCdata(m[1]) : "";
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
function parseRss(xml: string, source: { id: string; title: string }): FeedItem[] {
  const items: FeedItem[] = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  for (const m of xml.matchAll(re)) {
    const block = m[0];
    const link = tag(block, "link");
    const content = tag(block, "content:encoded") || tag(block, "description");
    items.push({
      id: link || tag(block, "guid"),
      title: decodeEntities(tag(block, "title")) || "(no title)",
      link,
      content,
      publishedAt: Date.parse(tag(block, "pubDate")) || 0,
      sourceId: source.id,
      sourceTitle: source.title,
    });
  }
  return items;
}

async function fetchLive(): Promise<FeedItem[]> {
  const out: FeedItem[] = [];
  for (const f of LIVE_FEEDS) {
    const res = await fetch(f.url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) vibe-feed-probe",
        accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) throw new Error(`${f.url} -> HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = parseRss(xml, f);
    console.log(`fetched ${parsed.length} items from ${f.title} (${f.url})`);
    out.push(...parsed);
  }
  return out;
}

// The item text the ranker embeds (ranker.ts itemText, replicated exactly) — used
// only to compute an authoritative raw top-cosine per profile for the separation
// report, since the ranker discards cosines when it floors to chronological.
function itemText(item: FeedItem): string {
  const body = item.content
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
  return `${item.title}. ${body}`;
}

interface ProfileResult {
  id: string;
  topics: string[];
  personalized: boolean;
  rankerTopScore: number; // top cosine as the CURRENT ranker reports it (0 when floored)
  rawTopCosine: number; // authoritative top cosine, computed directly (never floored)
  top3: { title: string; source: string; cosine: number }[];
}

// on-topic keyword sets for a coarse, deterministic on-topic judgement of the
// top-3 titles+bodies. Deliberately generous synonyms so a genuinely on-topic
// article isn't missed on vocabulary.
const ONTOPIC: Record<string, string[]> = {
  Rust: ["rust", "cargo", "crate", "rustc", "borrow", "tokio", "wasm", "ownership"],
  Security: [
    "security",
    "secure",
    "vulnerab",
    "cve",
    "exploit",
    "auth",
    "encrypt",
    "attack",
    "malware",
    "patch",
    "supply chain",
    "credential",
    "token",
    "phishing",
    " transitive",
  ],
  Databases: [
    "database",
    "sql",
    "postgres",
    "mysql",
    "sqlite",
    "query",
    "index",
    "schema",
    "nosql",
    "redis",
    "mongo",
    "table",
    "transaction",
  ],
};
function isOnTopic(profileId: string, item: { title: string; content: string }): boolean {
  const kws = ONTOPIC[profileId];
  if (!kws) return false;
  const hay = `${item.title} ${item.content}`.toLowerCase();
  // Word-boundary match, not substring: `includes("rust")` also fires on
  // "trust"/"entrust", fabricating an ON-TOPIC flag on a chronological item.
  return kws.some((k) => {
    const kw = k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${kw}\\b`, "i").test(hay);
  });
}

let items: FeedItem[] = [];
let results: ProfileResult[] = [];
let fetchError: string | null = null;

describe("real-data ranking-quality probe (inc6, live)", () => {
  beforeAll(async () => {
    try {
      items = await fetchLive();
    } catch (e) {
      fetchError = String(e);
      console.error("LIVE FETCH FAILED:", fetchError);
      return;
    }

    // Inject one guaranteed-on-topic item per unreliable-coverage profile, so the
    // ranker is measured against content it can actually rank rather than the
    // snapshot's editorial luck. The unrelated profile is deliberately left with
    // no match and must still floor.
    items.push(...Object.values(SYNTHETIC));

    // One extractor for the authoritative raw-cosine side computation, reused
    // across profiles (mirrors the ranker's own singleton + item-vector cache).
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = (await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { device: "cpu", dtype: "q8" }
    )) as unknown as (
      t: string,
      o: { pooling: "mean"; normalize: true }
    ) => Promise<{ tolist(): number[][] }>;
    const embed = async (t: string) =>
      (await extractor(t, { pooling: "mean", normalize: true })).tolist()[0];
    const itemVecs = new Map<string, number[]>();
    for (const it of items) itemVecs.set(it.id, await embed(itemText(it)));

    // The CURRENT shipping ranker. onPersonalized reports floor vs real ranking.
    let personalized = true;
    const ranker = createEmbeddingRanker(undefined, (p) => (personalized = p));

    for (const profile of PROFILES) {
      const ranked: RankedItem[] = await ranker.rank(items, {
        topics: profile.topics,
      });
      const rankerTopScore = ranked.reduce((m, r) => Math.max(m, r.score), 0);

      let rawTopCosine = 0;
      if (profile.topics.length > 0) {
        const q = await embed(profile.topics.join(", "));
        for (const it of items) {
          rawTopCosine = Math.max(rawTopCosine, cosineSimilarity(q, itemVecs.get(it.id)!));
        }
      }

      results.push({
        id: profile.id,
        topics: profile.topics,
        personalized,
        rankerTopScore,
        rawTopCosine,
        top3: ranked.slice(0, 3).map((r) => ({
          title: r.item.title,
          source: r.item.sourceTitle,
          cosine: r.score,
        })),
      });
    }

    // --- Report ---
    console.log(`\n=== REAL-DATA RANKING PROBE — ${items.length} live items ===`);
    for (const r of results) {
      const floored = !r.personalized && r.topics.length > 0;
      console.log(
        `\n[${r.id}] topics=${JSON.stringify(r.topics)}  personalized=${r.personalized}` +
          (floored ? "  (FLOOR: chronological, below MIN_TOP_COSINE)" : "")
      );
      console.log(
        `  rawTopCosine=${r.rawTopCosine.toFixed(4)}  rankerTopScore=${r.rankerTopScore.toFixed(4)}` +
          `  floor=${MIN_TOP_COSINE}`
      );
      r.top3.forEach((t, i) => {
        const flag = ONTOPIC[r.id]
          ? isOnTopic(r.id, { title: t.title, content: items.find((x) => x.title === t.title)?.content ?? "" })
            ? "ON-TOPIC"
            : "off?"
          : "-";
        console.log(`   ${i + 1}. cos=${t.cosine.toFixed(3)} [${flag}] ${t.title}  (${t.source})`);
      });
    }
    console.log("");
  }, 600_000);

  it("fetched real items from the live feeds", () => {
    expect(fetchError, `live fetch failed: ${fetchError}`).toBeNull();
    expect(items.length).toBeGreaterThan(0);
  });

  it("cold-start ([]) is the chronological floor (personalized=false)", () => {
    const r = results.find((x) => x.id === "cold-start")!;
    expect(r.personalized).toBe(false);
  });

  it("unrelated profile hits the FLOOR (personalized=false), not a fake ranking", () => {
    const r = results.find((x) => x.id === "unrelated")!;
    expect(r.personalized).toBe(false);
    expect(r.rawTopCosine).toBeLessThan(MIN_TOP_COSINE);
  });

  it("a genuine on-topic interest (Security) clears the floor and personalizes", () => {
    // Security is a staple of software-engineering feeds, so its top cosine
    // consistently clears the floor. Weaker interests (e.g. Rust in a snapshot
    // with no Rust articles, ~0.20) correctly floor now that the bar is 0.22 —
    // so this pins only the strong case; the floor's discrimination is covered by
    // the cold-start / unrelated / separation checks.
    const r = results.find((x) => x.id === "Security")!;
    expect(r.personalized, "Security should be personalized").toBe(true);
    expect(r.rawTopCosine, "Security top cosine above floor").toBeGreaterThanOrEqual(
      MIN_TOP_COSINE
    );
  });

  it("an injected on-topic Rust item ranks top-3 and personalizes", () => {
    const r = results.find((x) => x.id === "Rust")!;
    expect(r.personalized, "Rust should personalize with a guaranteed on-topic item present").toBe(
      true
    );
    expect(
      r.top3.some((t) => t.title === SYNTHETIC.Rust.title),
      `injected Rust item should rank top-3 (got: ${r.top3.map((t) => t.title).join(" | ")})`
    ).toBe(true);
  });

  it("an injected on-topic Databases item ranks top-3 and personalizes", () => {
    const r = results.find((x) => x.id === "Databases")!;
    expect(
      r.personalized,
      "Databases should personalize with a guaranteed on-topic item present"
    ).toBe(true);
    expect(
      r.top3.some((t) => t.title === SYNTHETIC.Databases.title),
      `injected Databases item should rank top-3 (got: ${r.top3.map((t) => t.title).join(" | ")})`
    ).toBe(true);
  });

  it("relevant top similarity clearly separates from the unrelated control", () => {
    const unrelated = results.find((x) => x.id === "unrelated")!;
    for (const id of ["Rust", "Security", "Databases"]) {
      const r = results.find((x) => x.id === id)!;
      expect(
        r.rawTopCosine,
        `${id} (${r.rawTopCosine.toFixed(3)}) should exceed unrelated control (${unrelated.rawTopCosine.toFixed(3)})`
      ).toBeGreaterThan(unrelated.rawTopCosine);
    }
  });
});

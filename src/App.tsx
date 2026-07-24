import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { fetchAllFeeds } from "./lib/rss";
import { createEmbeddingRanker } from "./lib/ranker";
import { PRESET_TOPICS, type UserInterests } from "./lib/personalize";
import { loadInterests, saveInterests, addTopic, toggleTopic } from "./lib/interests";
import { mockSummarizer, isWebGPUAvailable, getMemoryInfo, type Summarizer } from "./lib/summarizer";
import type { FeedItem } from "./lib/types";

// Minimal UI. Each card shows title + full text + an LLM summary (mockSummarizer
// by default). The interests panel lets the reader edit their topics; the feed
// is reordered through the Ranker seam whenever items or interests change. The
// active ranker is the on-device embedding reranker, which degrades to the
// lexical baseline on any failure — the header label states which one ran.

// Strip HTML to plain text for display/summarization.
function toPlainText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function Card({ item, summarizer }: { item: FeedItem; summarizer: Summarizer }) {
  const fullText = useMemo(() => toPlainText(item.content), [item.content]);
  const [summary, setSummary] = useState<string>("…");

  useEffect(() => {
    let alive = true;
    summarizer.summarize(fullText).then((s) => {
      if (alive) setSummary(s);
    });
    return () => {
      alive = false;
    };
  }, [fullText, summarizer]);

  return (
    <li className="card">
      <a className="card__title" href={item.link} target="_blank" rel="noreferrer">
        {item.title}
      </a>
      <div className="card__meta">{item.sourceTitle}</div>

      <div className="card__summary">
        <span className="card__summary-label">Summary</span>
        {summary}
      </div>

      <details className="card__full">
        <summary>Full text</summary>
        <p>{fullText}</p>
      </details>
    </li>
  );
}

export function App() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Interest model, restored from localStorage (prefilled defaults on first
  // visit) and persisted on every change.
  const [interests, setInterests] = useState<UserInterests>(() => loadInterests());
  const [draft, setDraft] = useState("");

  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [ranking, setRanking] = useState(false);
  const [mode, setMode] = useState<"semantic" | "lexical" | null>(null);

  // One stable ranker for the app's lifetime — its loaded model and per-id
  // vector cache live inside it, so they survive re-renders and re-ranks.
  const ranker = useMemo(() => createEmbeddingRanker(setMode), []);

  useEffect(() => {
    fetchAllFeeds()
      .then(setItems)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    saveInterests(interests);
  }, [interests]);

  // Rank the feed through the async Ranker seam, off the render path, whenever
  // the items or interests change. `alive` guards against a stale async result
  // landing after a newer rank started.
  useEffect(() => {
    let alive = true;
    setRanking(true);
    ranker.rank(items, interests).then((ranked) => {
      if (!alive) return;
      setFeed(ranked);
      setRanking(false);
    });
    return () => {
      alive = false;
    };
  }, [items, interests, ranker]);

  const commitDraft = () => {
    setInterests((prev) => addTopic(prev, draft));
    setDraft("");
  };

  const onDraftKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft();
    }
  };

  // Whether a topic is currently in the interest model (case-insensitive, so a
  // preset and a stored custom topic of the same word don't both light up).
  const activeTopics = new Set(interests.topics.map((t) => t.toLowerCase()));
  const isActive = (topic: string) => activeTopics.has(topic.toLowerCase());

  // The toggle chips: every preset, plus any active topic the reader added that
  // isn't a preset (so custom interests stay visible and removable).
  const toggleTopics = [
    ...PRESET_TOPICS,
    ...interests.topics.filter(
      (t) => !PRESET_TOPICS.some((p) => p.toLowerCase() === t.toLowerCase())
    ),
  ];

  const topicCount = interests.topics.length;

  // Persistent status line above the feed: skeletons cover the initial fetch,
  // "Ranking…" shows while a rank is in flight (real during the embeddings model
  // load), otherwise the article count + how the order was produced.
  const statusText = loading
    ? "Loading feeds…"
    : ranking
      ? "Ranking…"
      : topicCount === 0
        ? `${feed.length} articles · chronological (no interests)`
        : `${feed.length} articles · ranked by ${topicCount} ${
            topicCount === 1 ? "interest" : "interests"
          }`;

  return (
    <main className="app">
      <header className="app__header">
        <h1>Vibe Feed</h1>
        {/* Which ranker produced the current order: the on-device embeddings, or
            the lexical baseline it fell back to. Shown once the first rank runs. */}
        {mode && (
          <span className="app__mode">
            ranking: {mode === "semantic" ? "semantic" : "lexical (fallback)"}
          </span>
        )}
        <span className="app__hint">
          WebGPU: {isWebGPUAvailable() ? "available" : "not available (mock LLM)"}
          {(() => {
            const { deviceMemoryGb, usedJsHeapMb } = getMemoryInfo();
            const parts: string[] = [];
            if (deviceMemoryGb !== undefined) parts.push(`~${deviceMemoryGb} GB RAM`);
            if (usedJsHeapMb !== undefined) parts.push(`${usedJsHeapMb} MB used`);
            return parts.length ? ` · ${parts.join(" · ")}` : "";
          })()}
        </span>
      </header>

      {/* Interests panel — the reader toggles the topics they care about. Each
          chip is a toggle (aria-pressed): active = filled, inactive = outline.
          Every toggle re-ranks the feed and persists to localStorage. The input
          below adds a custom topic outside the presets. */}
      <section className="interests">
        <span className="interests__label">My interests:</span>
        <div className="interests__toggles">
          {toggleTopics.map((topic) => {
            const active = isActive(topic);
            return (
              <button
                key={topic}
                type="button"
                className={active ? "toggle toggle--on" : "toggle"}
                aria-pressed={active}
                onClick={() => setInterests((prev) => toggleTopic(prev, topic))}
              >
                {topic}
              </button>
            );
          })}
        </div>
        <input
          className="interests__input"
          type="text"
          value={draft}
          placeholder="Add a custom topic and press Enter…"
          aria-label="Add a custom interest topic"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onDraftKeyDown}
        />
      </section>

      {error ? (
        <p className="app__state app__state--error">{error}</p>
      ) : (
        <p className="feed__status" aria-live="polite">
          {statusText}
        </p>
      )}

      {loading ? (
        // Skeleton cards make the initial fetch obvious instead of a line of text
        // that's easy to miss.
        <ul className="feed" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="card card--skeleton">
              <div className="skeleton skeleton--title" />
              <div className="skeleton skeleton--meta" />
              <div className="skeleton skeleton--summary" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="feed">
          {feed.map((item) => (
            <Card key={item.id} item={item} summarizer={mockSummarizer} />
          ))}
        </ul>
      )}
    </main>
  );
}

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { fetchAllFeeds } from "./lib/rss";
import { lexicalRanker } from "./lib/ranker";
import type { UserInterests } from "./lib/personalize";
import { loadInterests, saveInterests, addTopic, removeTopic } from "./lib/interests";
import { mockSummarizer, isWebGPUAvailable, getMemoryInfo, type Summarizer } from "./lib/summarizer";
import type { FeedItem } from "./lib/types";

// Minimal UI. Each card shows title + full text + an LLM summary (mockSummarizer
// by default). The interests panel lets the reader edit their topics; the feed
// is reordered through the Ranker seam (lexicalRanker) whenever items or
// interests change.

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
    lexicalRanker.rank(items, interests).then((ranked) => {
      if (!alive) return;
      setFeed(ranked);
      setRanking(false);
    });
    return () => {
      alive = false;
    };
  }, [items, interests]);

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

  return (
    <main className="app">
      <header className="app__header">
        <h1>Vibe Feed</h1>
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

      {/* Interests panel — the reader edits their topics here. Type a topic and
          press Enter or comma to add a chip; the × removes it. Every change
          re-ranks the feed and persists to localStorage. */}
      <section className="interests">
        <span className="interests__label">My interests:</span>
        <ul className="interests__chips">
          {interests.topics.map((topic) => (
            <li key={topic} className="chip">
              {topic}
              <button
                type="button"
                className="chip__remove"
                aria-label={`Remove ${topic}`}
                onClick={() => setInterests((prev) => removeTopic(prev, topic))}
              >
                ×
              </button>
            </li>
          ))}
          {interests.topics.length === 0 && (
            <li className="interests__empty">(none yet — cold start)</li>
          )}
        </ul>
        <input
          className="interests__input"
          type="text"
          value={draft}
          placeholder="Add a topic and press Enter…"
          aria-label="Add an interest topic"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onDraftKeyDown}
        />
      </section>

      {loading && <p className="app__state">Loading feeds…</p>}
      {ranking && !loading && <p className="app__state">Ranking…</p>}
      {error && <p className="app__state app__state--error">{error}</p>}

      <ul className="feed">
        {feed.map((item) => (
          <Card key={item.id} item={item} summarizer={mockSummarizer} />
        ))}
      </ul>
    </main>
  );
}

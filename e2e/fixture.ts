import type { Page } from "@playwright/test";

// A fixed, clearly-topical corpus for deterministic ranking assertions.
//
// Design constraints baked into the data:
//  - The single NEWEST item (by pubDate) is a non-Rust AI item, so the
//    chronological (no-topics) #1 differs from the Rust-topic #1.
//  - Several Rust items carry "Rust" in the TITLE (lexical title weight), so a
//    Rust-only interest ranks a Rust item first under the deterministic lexical
//    ranker the spec forces (model CDN blocked).
//  - Several Security items and several generic AI/web items exist.
//  - Exactly one gardening item, deliberately written WITHOUT the tokens
//    "cooking" or "recipe(s)" — so selecting only the custom topic
//    "cooking recipes" matches nothing and the feed falls back to chronological.
//  - No non-Rust item contains the token "rust".
//
// Items are split across the three intercepted sources so every link (== item
// id) is unique and the app renders each once (no duplicate-key collisions).

type Group = "local" | "github" | "devto";

interface Item {
  title: string;
  link: string;
  description: string;
  body: string; // goes into content:encoded as HTML
  pubDate: string; // RFC-822
  group: Group;
}

const ITEMS: Item[] = [
  // --- newest overall: a non-Rust AI item → chronological #1 ---
  {
    title: "On-device AI models now summarize your articles",
    link: "https://example.com/on-device-ai-summaries",
    description: "Small on-device AI models summarize short articles in the browser.",
    body:
      "<p>On-device AI keeps moving forward. A quantized model running in the browser can now produce a one-paragraph summary of an article with no server call.</p>" +
      "<p>The model, its embeddings, and inference all stay local, so nothing about what you read leaves the device. This is the kind of ai and llm workload that used to require a backend.</p>",
    pubDate: "Mon, 20 Jul 2026 09:00:00 GMT",
    group: "local",
  },
  {
    title: "Critical OpenSSL vulnerability breaks TLS security",
    link: "https://example.com/openssl-tls-vuln",
    description: "A critical vulnerability lets attackers bypass TLS.",
    body:
      "<p>A newly disclosed security vulnerability in a widely used TLS library lets an attacker downgrade encryption and intercept traffic.</p>" +
      "<p>Operators should patch immediately. Security teams are tracking active exploitation in the wild.</p>",
    pubDate: "Sun, 19 Jul 2026 09:00:00 GMT",
    group: "local",
  },
  {
    title: "Rust 1.90 stabilizes async fn in traits",
    link: "https://example.com/rust-190-async-traits",
    description: "The Rust release stabilizes long-awaited async trait support.",
    body:
      "<p>Rust 1.90 lands async fn in traits on stable. The rust team has iterated on this for years, and the borrow checker and ownership model made it a hard problem.</p>" +
      "<p>Cargo and the wider rust crate ecosystem already ship examples. Memory safety without a garbage collector remains rust's headline promise.</p>",
    pubDate: "Fri, 18 Jul 2026 09:00:00 GMT",
    group: "local",
  },
  {
    title: "The web platform ships container queries everywhere",
    link: "https://example.com/web-container-queries",
    description: "CSS container queries reach every major browser.",
    body:
      "<p>The web platform now ships CSS container queries across every major browser. Components can finally respond to their own size instead of the viewport.</p>" +
      "<p>It is a meaningful step for the web and for layout on the modern web platform.</p>",
    pubDate: "Thu, 17 Jul 2026 09:00:00 GMT",
    group: "local",
  },
  {
    title: "Security best practices for API keys and secrets",
    link: "https://example.com/security-secrets",
    description: "How to store and rotate secrets safely.",
    body:
      "<p>Good security starts with never committing secrets. Store API keys in a vault, rotate them on a schedule, and scope each credential narrowly.</p>" +
      "<p>These security practices cut the blast radius of any single leak.</p>",
    pubDate: "Wed, 16 Jul 2026 09:00:00 GMT",
    group: "github",
  },
  {
    title: "Rewriting our log parser in Rust for memory safety",
    link: "https://example.com/rust-log-parser",
    description: "Why a team moved a hot parser to Rust.",
    body:
      "<p>We rewrote our log parser in rust. The borrow checker caught a class of bugs our previous parser shipped for years, and rust gave us memory safety with no runtime cost.</p>" +
      "<p>Throughput went up and crashes went to zero.</p>",
    pubDate: "Tue, 15 Jul 2026 09:00:00 GMT",
    group: "github",
  },
  {
    title: "Building faster web apps with modern browser APIs",
    link: "https://example.com/faster-web-apps",
    description: "Modern browser APIs make web apps faster.",
    body:
      "<p>A tour of modern browser APIs for building faster web apps: scheduling, streaming, and off-main-thread work.</p>" +
      "<p>The web keeps closing the gap with native, and these browser primitives are how.</p>",
    pubDate: "Mon, 14 Jul 2026 09:00:00 GMT",
    group: "github",
  },
  {
    title: "Phishing campaign targets developer security credentials",
    link: "https://example.com/phishing-devs",
    description: "A phishing wave aimed at developers.",
    body:
      "<p>A phishing campaign is targeting developer accounts, harvesting tokens and bypassing weak second factors. Security awareness and hardware keys are the defense.</p>" +
      "<p>Enable phishing-resistant MFA on every account.</p>",
    pubDate: "Sun, 13 Jul 2026 09:00:00 GMT",
    group: "github",
  },
  {
    title: "Rust ownership and borrowing, explained",
    link: "https://example.com/rust-ownership",
    description: "A gentle introduction to Rust's ownership model.",
    body:
      "<p>Ownership is the idea at the heart of rust. Every value has a single owner, borrowing lends access without giving it away, and lifetimes keep references valid.</p>" +
      "<p>Once it clicks, rust stops fighting you.</p>",
    pubDate: "Sat, 12 Jul 2026 09:00:00 GMT",
    group: "devto",
  },
  // --- the one gardening item: NO "cooking"/"recipe(s)" tokens on purpose ---
  {
    title: "Raised garden beds for tomatoes and herbs",
    link: "https://example.com/raised-garden-beds",
    description: "Build a raised bed and grow tomatoes and herbs.",
    body:
      "<p>A raised garden bed warms up early and drains well. Fill it with a mix of compost and topsoil, give it six hours of sun, and water deeply but less often.</p>" +
      "<p>Tomatoes love the heat; basil and mint thrive alongside. Mulch to hold moisture and prune for airflow.</p>",
    pubDate: "Fri, 11 Jul 2026 09:00:00 GMT",
    group: "devto",
  },
];

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function itemXml(item: Item): string {
  return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${item.link}</link>
      <description>${escapeXml(item.description)}</description>
      <content:encoded><![CDATA[${item.body}]]></content:encoded>
      <pubDate>${item.pubDate}</pubDate>
    </item>`;
}

function buildRss(group: Group): string {
  const items = ITEMS.filter((i) => i.group === group).map(itemXml).join("\n\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Fixture — ${group}</title>
    <link>http://localhost:5199/</link>
    <description>Deterministic e2e fixture (${group}).</description>

${items}
  </channel>
</rss>`;
}

// Total number of distinct items the deterministic feed renders.
export const FIXTURE_ITEM_COUNT = ITEMS.length;

/**
 * Make the feed deterministic:
 *  - Every RSS source (local mock, github.blog/feed, dev.to/feed) is fulfilled
 *    from the fixed fixture — no live network.
 *  - The on-device model CDN (HuggingFace + common asset CDNs) is aborted, which
 *    forces the ranker down its deterministic lexical fallback path. The header
 *    then reads "ranking: lexical (fallback)" — a valid settle signal.
 *
 * Must be called BEFORE page.goto so the initial fetches are intercepted.
 */
export async function setupDeterministicFeed(page: Page): Promise<void> {
  const xml = (group: Group) => ({
    status: 200,
    contentType: "application/xml; charset=utf-8",
    body: buildRss(group),
  });

  await page.route(/mock-feed\.xml(\?.*)?$/, (route) => route.fulfill(xml("local")));
  await page.route(/github\.blog\/feed/, (route) => route.fulfill(xml("github")));
  await page.route(/dev\.to\/feed/, (route) => route.fulfill(xml("devto")));

  // Force the deterministic lexical ranker by denying the model weights.
  await page.route(/huggingface\.co/, (route) => route.abort("failed"));
  await page.route(/hf\.co/, (route) => route.abort("failed"));
  await page.route(/cdn\.jsdelivr\.net/, (route) => route.abort("failed"));
  await page.route(/unpkg\.com/, (route) => route.abort("failed"));
}

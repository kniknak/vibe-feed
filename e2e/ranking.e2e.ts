import { test, expect, type Page } from "@playwright/test";
import { setupDeterministicFeed, FIXTURE_ITEM_COUNT } from "./fixture";

// End-to-end ranking-quality assertions against a fully deterministic feed:
// every RSS source and the on-device model CDN are intercepted (see fixture.ts),
// so the order is produced by the deterministic lexical ranker with no network.

const cardTitles = (page: Page) => page.locator(".feed .card__title");
const matchBadges = (page: Page) => page.locator(".feed .card__match");
const status = (page: Page) => page.locator(".feed__status");

// Wait for the first rank to settle: the header mode label appears once a rank
// has run, and the status line resolves to a real article count / chronological
// label (no longer "Loading feeds…" or "Ranking…"). Generous timeout — the first
// rank still imports the transformers.js module in dev before falling back.
async function waitForSettle(page: Page): Promise<void> {
  await expect(page.locator(".app__mode")).toBeVisible({ timeout: 90_000 });
  await expect(status(page)).toHaveText(/articles|chronological/, { timeout: 90_000 });
  await expect(cardTitles(page).first()).toBeVisible({ timeout: 90_000 });
}

// Turn OFF the three prefilled default topics to reach the true no-topics
// chronological state, then confirm we're there.
async function clearDefaultTopics(page: Page): Promise<void> {
  for (const topic of ["AI & LLMs", "Web platform", "Security"]) {
    await page.getByRole("button", { name: topic, exact: true }).click();
  }
  await expect(status(page)).toHaveText(/chronological \(no interests\)/, {
    timeout: 60_000,
  });
}

test.beforeEach(async ({ page }) => {
  await setupDeterministicFeed(page);
  await page.goto("/vibe-feed/");
  await waitForSettle(page);
  // Sanity: the deterministic feed rendered the full fixture once (unique ids).
  await expect(cardTitles(page)).toHaveCount(FIXTURE_ITEM_COUNT, { timeout: 60_000 });
});

test("Rust-only ranks a Rust item #1, differing from the cold-start #1", async ({
  page,
}) => {
  await clearDefaultTopics(page);

  // Cold start (no topics) → chronological: capture the current #1.
  const coldStartFirst = (await cardTitles(page).first().textContent())?.trim();
  expect(coldStartFirst, "cold-start #1 should be resolved").toBeTruthy();

  // Personalize on a single, sharp topic.
  await page.getByRole("button", { name: "Rust", exact: true }).click();
  await expect(status(page)).toHaveText(/ranked by 1 interest/, { timeout: 60_000 });

  // (1a) #1 is now a Rust item …
  const firstCard = cardTitles(page).first();
  await expect(firstCard).toContainText("Rust", { timeout: 60_000 });

  // (1b) … and it differs from the cold-start #1.
  const rustFirst = (await firstCard.textContent())?.trim();
  expect(rustFirst).not.toBe(coldStartFirst);
});

test("'% match' badges render on cards when the feed is personalized", async ({
  page,
}) => {
  // The default state (3 prefilled topics with matches) is a real ranking.
  await expect(status(page)).toHaveText(/ranked by \d+ interests?/, { timeout: 60_000 });

  await expect(matchBadges(page).first()).toBeVisible({ timeout: 60_000 });
  expect(await matchBadges(page).count()).toBeGreaterThan(0);
  await expect(matchBadges(page).first()).toHaveText(/\d+% match/);
});

test("an unrelated custom topic falls back to chronological with no match badges", async ({
  page,
}) => {
  await clearDefaultTopics(page);

  const input = page.getByLabel("Add a custom interest topic");
  await input.fill("cooking recipes");
  await input.press("Enter");

  // (3) chronological-fallback label (nothing in the tech feed matched) …
  await expect(status(page)).toHaveText(/chronological \(no strong matches\)/, {
    timeout: 60_000,
  });
  // … and NO "% match" badges, nor the personalized-only filter control.
  await expect(matchBadges(page)).toHaveCount(0);
  await expect(page.locator(".feed__filter")).toHaveCount(0);
});

test("'Hide low matches' reduces the visible card count", async ({ page }) => {
  await clearDefaultTopics(page);

  await page.getByRole("button", { name: "Rust", exact: true }).click();
  await expect(status(page)).toHaveText(/ranked by 1 interest/, { timeout: 60_000 });

  const before = await cardTitles(page).count();
  expect(before).toBeGreaterThan(1);

  // The filter is only offered on a personalized ranking.
  const toggle = page.locator('.feed__filter input[type="checkbox"]');
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await toggle.check();

  // (4) fewer cards remain (weak / zero-relevance items are hidden).
  await expect
    .poll(async () => cardTitles(page).count(), { timeout: 30_000 })
    .toBeLessThan(before);
});

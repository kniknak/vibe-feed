// Persistence + editing for the reader's interest model. Interests live entirely
// on the device — they are read from and written to localStorage and never leave
// the browser. These helpers are pure (the Storage is injectable) so the UI can
// stay thin and the logic is testable without a DOM.

import { DEFAULT_INTERESTS, type UserInterests } from "./personalize";

const STORAGE_KEY = "vibe-feed:interests";

// Load the saved interests. Nothing stored yet (first visit) → the prefilled
// defaults, so a new reader gets a personalized order immediately. A stored but
// empty list is respected (the reader cleared their topics on purpose) and only
// corrupt/unparseable data falls back to the defaults.
export function loadInterests(storage: Storage = localStorage): UserInterests {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return DEFAULT_INTERESTS;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { topics: parsed.filter((t): t is string => typeof t === "string") };
    }
  } catch {
    // fall through to the defaults on malformed storage
  }
  return DEFAULT_INTERESTS;
}

// Persist the current interests. Called on every change.
export function saveInterests(
  interests: UserInterests,
  storage: Storage = localStorage
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(interests.topics));
}

// Add a topic, returning a new interest model. Blank/whitespace-only input and
// case-insensitive duplicates are rejected (the model is returned unchanged).
export function addTopic(interests: UserInterests, raw: string): UserInterests {
  const topic = raw.trim();
  if (topic === "") return interests;

  const exists = interests.topics.some(
    (t) => t.toLowerCase() === topic.toLowerCase()
  );
  if (exists) return interests;

  return { topics: [...interests.topics, topic] };
}

// Remove a topic (exact match — chips carry the exact stored string).
export function removeTopic(
  interests: UserInterests,
  topic: string
): UserInterests {
  return { topics: interests.topics.filter((t) => t !== topic) };
}

// Toggle a topic on or off, returning a new interest model. Case-insensitive:
// a topic already present (any casing) is removed; an absent one is added
// trimmed. Blank/whitespace-only input is rejected (the model is unchanged).
// This backs the preset toggle chips.
export function toggleTopic(
  interests: UserInterests,
  raw: string
): UserInterests {
  const topic = raw.trim();
  if (topic === "") return interests;

  const lower = topic.toLowerCase();
  const exists = interests.topics.some((t) => t.toLowerCase() === lower);
  if (exists) {
    return { topics: interests.topics.filter((t) => t.toLowerCase() !== lower) };
  }
  return { topics: [...interests.topics, topic] };
}

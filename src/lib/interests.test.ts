import { describe, it, expect } from "vitest";
import {
  loadInterests,
  saveInterests,
  addTopic,
  removeTopic,
} from "./interests";
import { DEFAULT_INTERESTS } from "./personalize";

// In-memory Storage shim so the pure helpers can be tested without a DOM.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

describe("loadInterests", () => {
  it("returns the prefilled defaults when nothing is stored", () => {
    expect(loadInterests(memoryStorage())).toEqual(DEFAULT_INTERESTS);
  });

  it("respects a stored empty list rather than falling back to defaults", () => {
    const storage = memoryStorage();
    saveInterests({ topics: [] }, storage);
    expect(loadInterests(storage)).toEqual({ topics: [] });
  });
});

describe("saveInterests / loadInterests", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    const interests = { topics: ["Rust", "WebGPU"] };
    saveInterests(interests, storage);
    expect(loadInterests(storage)).toEqual(interests);
  });
});

describe("addTopic", () => {
  it("trims surrounding whitespace", () => {
    expect(addTopic({ topics: [] }, "  Rust  ")).toEqual({ topics: ["Rust"] });
  });

  it("rejects blank / whitespace-only input", () => {
    const interests = { topics: ["Rust"] };
    expect(addTopic(interests, "")).toEqual(interests);
    expect(addTopic(interests, "   ")).toEqual(interests);
  });

  it("rejects a case-insensitive duplicate", () => {
    expect(addTopic({ topics: ["Rust"] }, "rust")).toEqual({ topics: ["Rust"] });
  });
});

describe("removeTopic", () => {
  it("removes the matching topic", () => {
    expect(removeTopic({ topics: ["a", "b"] }, "a")).toEqual({ topics: ["b"] });
  });
});

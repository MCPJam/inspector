import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTourSystemPromptsForTests,
  readTourSystemPrompt,
  writeTourSystemPrompt,
} from "../tour-session-prompt";

const STORAGE_KEY = "mcpjam:agent-tour-system-prompts:v1";

beforeEach(() => {
  __resetTourSystemPromptsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tour-session-prompt", () => {
  it("roundtrips a system prompt by session id", () => {
    writeTourSystemPrompt("sess-1", {
      tourId: "tour-a",
      systemPrompt: "You are running tour A.",
    });
    expect(readTourSystemPrompt("sess-1")).toBe("You are running tour A.");
    expect(readTourSystemPrompt("sess-other")).toBeNull();
  });

  it("re-writing the same session replaces rather than duplicates", () => {
    writeTourSystemPrompt("sess-1", { tourId: "tour-a", systemPrompt: "v1" });
    writeTourSystemPrompt("sess-1", { tourId: "tour-a", systemPrompt: "v2" });
    expect(readTourSystemPrompt("sess-1")).toBe("v2");
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) as string,
    ) as unknown[];
    expect(stored).toHaveLength(1);
  });

  it("caps the registry MRU-style, evicting the oldest entry", () => {
    for (let i = 1; i <= 13; i++) {
      writeTourSystemPrompt(`sess-${i}`, {
        tourId: "tour-a",
        systemPrompt: `prompt ${i}`,
      });
    }
    // Oldest launch evicted; the 12 most recent survive.
    expect(readTourSystemPrompt("sess-1")).toBeNull();
    expect(readTourSystemPrompt("sess-2")).toBe("prompt 2");
    expect(readTourSystemPrompt("sess-13")).toBe("prompt 13");
  });

  it("returns null (not a throw) on corrupt stored JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readTourSystemPrompt("sess-1")).toBeNull();
    // And a write on top of corruption recovers cleanly.
    writeTourSystemPrompt("sess-1", { tourId: "tour-a", systemPrompt: "ok" });
    expect(readTourSystemPrompt("sess-1")).toBe("ok");
  });

  it("filters malformed entries instead of trusting the array shape", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { sessionId: "sess-bad" }, // missing fields
        {
          sessionId: "sess-1",
          tourId: "tour-a",
          systemPrompt: "kept",
          ts: 1,
        },
      ]),
    );
    expect(readTourSystemPrompt("sess-bad")).toBeNull();
    expect(readTourSystemPrompt("sess-1")).toBe("kept");
  });

  // jsdom's window.localStorage does not route through Storage.prototype, so
  // spy the instance (same note as launch-lesson.test.ts).

  it("swallows setItem failures (quota/disabled storage)", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() =>
      writeTourSystemPrompt("sess-1", {
        tourId: "tour-a",
        systemPrompt: "p",
      }),
    ).not.toThrow();
  });

  it("swallows getItem failures and reads as empty", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readTourSystemPrompt("sess-1")).toBeNull();
  });
});

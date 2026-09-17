import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_TAG_SCRIPT_BASE,
  loadGoogleTag,
  parseGoogleTagIds,
  shouldLoadGoogleTag,
} from "../google-tag";

type StubWindow = {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  isElectron?: boolean;
  location: { href: string };
};

function makeWindow(overrides: Partial<StubWindow> = {}): StubWindow {
  return {
    location: { href: "https://app.mcpjam.com/" },
    ...overrides,
  };
}

function injectedScripts(doc: Document): HTMLScriptElement[] {
  return Array.from(
    doc.head.querySelectorAll<HTMLScriptElement>(
      `script[src^="${GOOGLE_TAG_SCRIPT_BASE}"]`,
    ),
  );
}

describe("parseGoogleTagIds", () => {
  it("returns nothing for an unset or empty value", () => {
    expect(parseGoogleTagIds(undefined)).toEqual([]);
    expect(parseGoogleTagIds("")).toEqual([]);
    expect(parseGoogleTagIds(" , ")).toEqual([]);
  });

  it("splits, trims, and keeps only Google-shaped ids", () => {
    expect(parseGoogleTagIds(" G-QY70M2J21T , AW-17658895514 ")).toEqual([
      "G-QY70M2J21T",
      "AW-17658895514",
    ]);
    // A stray value must not become a script URL parameter.
    expect(parseGoogleTagIds("G-ABC123,not-an-id,<script>")).toEqual([
      "G-ABC123",
    ]);
  });
});

describe("shouldLoadGoogleTag", () => {
  it("is off without ids, off the hosted surface, and inside Electron", () => {
    const win = makeWindow() as unknown as Window;
    expect(shouldLoadGoogleTag({ ids: [], hostedMode: true, win })).toBe(false);
    expect(
      shouldLoadGoogleTag({ ids: ["G-ABC123"], hostedMode: false, win }),
    ).toBe(false);
    expect(
      shouldLoadGoogleTag({
        ids: ["G-ABC123"],
        hostedMode: true,
        win: makeWindow({ isElectron: true }) as unknown as Window,
      }),
    ).toBe(false);
  });

  it("is on for the hosted web surface with ids configured", () => {
    expect(
      shouldLoadGoogleTag({
        ids: ["G-ABC123"],
        hostedMode: true,
        win: makeWindow() as unknown as Window,
      }),
    ).toBe(true);
  });
});

describe("loadGoogleTag", () => {
  let doc: Document;

  beforeEach(() => {
    doc = document.implementation.createHTMLDocument("test");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects gtag.js once and queues a config for every id", () => {
    const win = makeWindow();
    const loaded = loadGoogleTag({
      ids: ["G-ABC123", "AW-987654"],
      hostedMode: true,
      win: win as unknown as Window,
      doc,
    });

    expect(loaded).toBe(true);
    const scripts = injectedScripts(doc);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(`${GOOGLE_TAG_SCRIPT_BASE}?id=G-ABC123`);
    expect(scripts[0].async).toBe(true);

    // The stub pushes `arguments` objects; read them back as arrays.
    const queued = (win.dataLayer ?? []).map((entry) =>
      Array.from(entry as ArrayLike<unknown>),
    );
    expect(queued[0][0]).toBe("js");
    expect(queued[0][1]).toBeInstanceOf(Date);
    expect(queued[1]).toEqual([
      "config",
      "G-ABC123",
      { page_location: "https://app.mcpjam.com/" },
    ]);
    expect(queued[2]).toEqual([
      "config",
      "AW-987654",
      { page_location: "https://app.mcpjam.com/" },
    ]);
    expect(typeof win.gtag).toBe("function");
  });

  it("is idempotent across repeated calls", () => {
    const win = makeWindow();
    const opts = {
      ids: ["G-ABC123"],
      hostedMode: true,
      win: win as unknown as Window,
      doc,
    };
    expect(loadGoogleTag(opts)).toBe(true);
    expect(loadGoogleTag(opts)).toBe(true);
    expect(injectedScripts(doc)).toHaveLength(1);
    // Second call must not re-queue a `js`/`config` pair either.
    expect(win.dataLayer).toHaveLength(2);
  });

  it("redacts credential share paths from page_location", () => {
    const win = makeWindow({
      location: { href: "https://app.mcpjam.com/results/sk-secret-token" },
    });
    loadGoogleTag({
      ids: ["G-ABC123"],
      hostedMode: true,
      win: win as unknown as Window,
      doc,
    });
    const config = Array.from((win.dataLayer ?? [])[1] as ArrayLike<unknown>);
    expect(config[2]).toEqual({
      page_location: "https://app.mcpjam.com/results/[redacted]",
    });
    expect(JSON.stringify(win.dataLayer)).not.toContain("sk-secret-token");
  });

  it("loads nothing off the hosted surface", () => {
    const win = makeWindow();
    expect(
      loadGoogleTag({
        ids: ["G-ABC123"],
        hostedMode: false,
        win: win as unknown as Window,
        doc,
      }),
    ).toBe(false);
    expect(injectedScripts(doc)).toHaveLength(0);
    expect(win.dataLayer).toBeUndefined();
    expect(win.gtag).toBeUndefined();
  });
});

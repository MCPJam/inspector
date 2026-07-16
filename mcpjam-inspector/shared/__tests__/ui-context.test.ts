import { describe, expect, it } from "vitest";
import {
  UI_CONTEXT_CLOSE,
  UI_CONTEXT_MAX_CHARS,
  UI_CONTEXT_OPEN,
  UI_CONTEXT_PREAMBLE,
  isRenderedUiContextText,
  parseUiContextPayload,
  renderUiContextText,
} from "../ui-context";

const VALID = {
  path: "/playground",
  activeTab: "playground",
  selectedServers: ["everything"],
  timestamp: "2026-07-15T12:00:00.000Z",
};

describe("parseUiContextPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(parseUiContextPayload(VALID)).toEqual(VALID);
  });

  it("accepts a payload with no selectedServers", () => {
    const { selectedServers: _drop, ...rest } = VALID;
    expect(parseUiContextPayload(rest)).toEqual(rest);
  });

  it("rejects malformed payloads rather than throwing", () => {
    // This arrives in a client-supplied message part, so it is untrusted —
    // but a bad block must not 400 a turn the user is waiting on.
    for (const bad of [
      null,
      undefined,
      "playground",
      [],
      {},
      { ...VALID, path: "" },
      { ...VALID, path: 42 },
      { ...VALID, activeTab: "" },
      { ...VALID, timestamp: 0 },
      { ...VALID, selectedServers: "everything" },
      { ...VALID, selectedServers: [1, 2] },
    ]) {
      expect(parseUiContextPayload(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("drops unknown keys", () => {
    expect(
      parseUiContextPayload({ ...VALID, secret: "do-not-forward" }),
    ).toEqual(VALID);
  });
});

describe("renderUiContextText", () => {
  it("renders an envelope the model can read", () => {
    const text = renderUiContextText(VALID)!;
    expect(text.startsWith(UI_CONTEXT_OPEN)).toBe(true);
    expect(text.endsWith(UI_CONTEXT_CLOSE)).toBe(true);
    expect(text).toContain("playground (/playground)");
    expect(text).toContain("everything");
    // Every earlier turn's block is still in history; without the timestamp
    // the model can't tell which "right now" is current.
    expect(text).toContain("Observed at: 2026-07-15T12:00:00.000Z");
  });

  it("says so explicitly when nothing is selected", () => {
    const text = renderUiContextText({ ...VALID, selectedServers: [] })!;
    expect(text).toContain("Selected servers: none");
  });

  it("returns null for an unusable payload so the caller drops the part", () => {
    expect(renderUiContextText({ path: "/x" })).toBeNull();
    expect(renderUiContextText(undefined)).toBeNull();
  });

  it("caps the block and keeps the closing marker", () => {
    const text = renderUiContextText({
      ...VALID,
      selectedServers: Array.from({ length: 500 }, (_, i) => `server-${i}`),
    })!;
    expect(text.length).toBeLessThanOrEqual(UI_CONTEXT_MAX_CHARS);
    expect(text.trimEnd().endsWith(UI_CONTEXT_CLOSE)).toBe(true);
    expect(isRenderedUiContextText(text)).toBe(true);
  });
});

describe("isRenderedUiContextText", () => {
  it("matches text we rendered", () => {
    expect(isRenderedUiContextText(renderUiContextText(VALID))).toBe(true);
  });

  it("does NOT match user text that merely mentions the marker", () => {
    // The persistence strip deletes whatever this matches. A substring match
    // would eat part of a real user message.
    expect(
      isRenderedUiContextText(`how do I use ${UI_CONTEXT_OPEN} exactly?`),
    ).toBe(false);
    expect(
      isRenderedUiContextText(`${UI_CONTEXT_OPEN} but never closed`),
    ).toBe(false);
    expect(isRenderedUiContextText("open the playground")).toBe(false);
    expect(isRenderedUiContextText(undefined)).toBe(false);
    expect(isRenderedUiContextText(42)).toBe(false);
  });

  it("does NOT match user text that WRAPS itself in both markers", () => {
    // Users of an MCP debugging tool paste and quote markers. Matching on
    // markers alone deleted their message from stored history — this is the
    // case that made marker-only matching unsafe.
    expect(
      isRenderedUiContextText(
        `${UI_CONTEXT_OPEN}\nwhat does this mean?\n${UI_CONTEXT_CLOSE}`,
      ),
    ).toBe(false);
    // Right preamble, but a free-text body rather than our `- Key: value`.
    expect(
      isRenderedUiContextText(
        `${UI_CONTEXT_OPEN}\n${UI_CONTEXT_PREAMBLE}\nnope\n${UI_CONTEXT_CLOSE}`,
      ),
    ).toBe(false);
    // Well-formed body, but not our preamble.
    expect(
      isRenderedUiContextText(
        `${UI_CONTEXT_OPEN}\nsomething else entirely:\n- Screen: x (/x)\n${UI_CONTEXT_CLOSE}`,
      ),
    ).toBe(false);
    // Markers only, no body at all.
    expect(
      isRenderedUiContextText(`${UI_CONTEXT_OPEN}\n${UI_CONTEXT_CLOSE}`),
    ).toBe(false);
  });
});

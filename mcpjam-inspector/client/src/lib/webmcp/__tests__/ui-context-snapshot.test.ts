import { describe, expect, it } from "vitest";
import {
  buildUiContextPart,
  buildUiContextPayload,
} from "../ui-context-snapshot";
import {
  UI_CONTEXT_PART_TYPE,
  parseUiContextPayload,
  renderUiContextText,
} from "@/shared/ui-context";

const now = () => Date.parse("2026-07-15T12:00:00.000Z");

describe("buildUiContextPayload", () => {
  it("resolves the active tab from the pathname", () => {
    expect(buildUiContextPayload({ pathname: "/playground", now })).toEqual({
      path: "/playground",
      activeTab: "playground",
      timestamp: "2026-07-15T12:00:00.000Z",
    });
  });

  it("resolves aliased paths to their canonical tab", () => {
    // `/hosts` is the `clients` tab; the model should be told the tab it can
    // actually navigate back to.
    expect(buildUiContextPayload({ pathname: "/hosts", now }).activeTab).toBe(
      "clients",
    );
    expect(buildUiContextPayload({ pathname: "/chat", now }).activeTab).toBe(
      "playground",
    );
  });

  it("includes selected server names when supplied", () => {
    expect(
      buildUiContextPayload({
        pathname: "/servers",
        selectedServers: ["everything", "chess"],
        now,
      }).selectedServers,
    ).toEqual(["everything", "chess"]);
  });

  it("omits selectedServers entirely when not supplied", () => {
    expect(
      buildUiContextPayload({ pathname: "/servers", now }),
    ).not.toHaveProperty("selectedServers");
  });

  it("falls back to a known tab for an unknown path", () => {
    expect(
      buildUiContextPayload({ pathname: "/not-a-real-screen", now }).activeTab,
    ).toBe("servers");
  });
});

describe("buildUiContextPart", () => {
  it("produces a part the shared parser and renderer accept", () => {
    // Client builder and server reader must agree — they're the two ends of
    // the same wire.
    const part = buildUiContextPart({ pathname: "/servers", now });
    expect(part.type).toBe(UI_CONTEXT_PART_TYPE);
    expect(parseUiContextPayload(part.data)).not.toBeNull();
    expect(renderUiContextText(part.data)).toContain("servers (/servers)");
  });
});

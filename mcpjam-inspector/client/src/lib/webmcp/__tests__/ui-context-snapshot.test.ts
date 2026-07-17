import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import {
  buildUiContextPart,
  buildUiContextPayload,
} from "../ui-context-snapshot";
import { publishSelectedServerNames } from "../ui-context-source";

afterEach(() => publishSelectedServerNames([]));
import {
  UI_CONTEXT_PART_TYPE,
  parseUiContextPayload,
  renderUiContextText,
} from "@/shared/ui-context";

const now = () => Date.parse("2026-07-15T12:00:00.000Z");

describe("buildUiContextPayload", () => {
  it("resolves the active tab from the pathname", () => {
    publishSelectedServerNames([]);
    expect(buildUiContextPayload({ pathname: "/playground", now })).toEqual({
      path: "/playground",
      activeTab: "playground",
      selectedServers: [],
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

  it("defaults selectedServers to the published selection", () => {
    // The agent hook can't reach app state, so App.tsx publishes the current
    // selection and the payload picks it up when the caller passes none.
    publishSelectedServerNames(["everything"]);
    expect(
      buildUiContextPayload({ pathname: "/servers", now }).selectedServers,
    ).toEqual(["everything"]);
  });

  it("reports an empty selection as empty, not absent", () => {
    publishSelectedServerNames([]);
    expect(
      buildUiContextPayload({ pathname: "/servers", now }).selectedServers,
    ).toEqual([]);
  });

  it("an explicit selection overrides the published one", () => {
    publishSelectedServerNames(["published"]);
    expect(
      buildUiContextPayload({
        pathname: "/servers",
        selectedServers: ["explicit"],
        now,
      }).selectedServers,
    ).toEqual(["explicit"]);
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

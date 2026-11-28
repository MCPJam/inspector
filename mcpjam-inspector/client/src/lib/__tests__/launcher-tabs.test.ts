import { describe, expect, it } from "vitest";
import {
  LAUNCHER_TAB_ALIASES,
  LAUNCHER_TABS,
  resolveLauncherTab,
} from "@/shared/launcher-tabs";
import {
  isKnownAppTabSegment,
  legacyHashBookmarkToPath,
  listKnownAppTabSegments,
} from "../app-navigation";
import { HASH_TAB_ALIASES, normalizeHostedHashTab } from "../hosted-tab-policy";

// `launchInspector()` validates `defaultTab` against shared/launcher-tabs.ts,
// and the client opens it from the env (path) and from the link's hash. These
// tests keep the launcher's list and the client's tab registry the same.
describe("launcher tabs", () => {
  it("names only tabs the client opens", () => {
    for (const tab of LAUNCHER_TABS) {
      expect(isKnownAppTabSegment(tab), tab).toBe(true);
      expect(normalizeHostedHashTab(tab), tab).toBe(tab);
    }
  });

  it("resolves each alias to the tab a link with that name opens", () => {
    for (const [alias, tab] of Object.entries(LAUNCHER_TAB_ALIASES)) {
      expect(isKnownAppTabSegment(tab), alias).toBe(true);
      expect(normalizeHostedHashTab(alias), alias).toBe(tab);
    }
  });

  it("accepts every tab and link alias the client knows", () => {
    // A screen added to shared/app-surfaces.ts, or an alias added to
    // HASH_TAB_ALIASES, also belongs in shared/launcher-tabs.ts; otherwise
    // `launchInspector({ defaultTab })` rejects a tab the client can open.
    for (const name of [
      ...listKnownAppTabSegments(),
      ...Object.keys(HASH_TAB_ALIASES),
    ]) {
      expect(resolveLauncherTab(name), name).toBe(normalizeHostedHashTab(name));
    }
  });

  it("opens Playground from an older launcher link", () => {
    for (const tab of ["chat", "app-builder", "chat-v2"]) {
      expect(legacyHashBookmarkToPath(`#${tab}`), tab).toBe("/playground");
    }
  });

  it("rejects a name that is not a tab", () => {
    expect(resolveLauncherTab("app-bulder")).toBeUndefined();
    expect(resolveLauncherTab("constructor")).toBeUndefined();
  });
});

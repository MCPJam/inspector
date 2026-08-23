import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/share-envelope.json";

const here = dirname(fileURLToPath(import.meta.url));
const hookSource = [
  readFileSync(join(here, "../../hooks/useShares.ts"), "utf8"),
  readFileSync(join(here, "../../hooks/useOrgSharePolicy.ts"), "utf8"),
].join("\n");

describe("share envelope contract fixture", () => {
  it("pins the Convex refs and envelope keys", () => {
    expect(Object.keys(fixture.convexRefs)).toEqual([
      "shares:getShareSettings",
      "shares:setShareMode",
      "shares:rotateShareLink",
      "shares:upsertShareMember",
      "shares:removeShareMember",
      "shares:revokeAllShares",
      "orgSharePolicy:getOrgSharePolicy",
      "orgSharePolicy:setOrgSharePolicy",
      "orgSharePolicy:getEffectiveSharePolicyForProject",
    ]);
    expect(fixture.shareSettingsEnvelope).toMatchObject({
      resourceType: "conformanceRun",
      mode: "anyone_with_link",
      policyVersion: 1,
    });
  });

  // The point of the fixture is to catch cross-repo drift, so it has to be
  // bound to something real. Comparing the imported JSON to a re-read of the
  // same file can never fail; these two assertions can.
  it("matches every ref the client actually calls", () => {
    const called = [
      ...hookSource.matchAll(/"((?:shares|orgSharePolicy):[A-Za-z]+)"/g),
    ].map((match) => match[1]);
    expect(called.length).toBeGreaterThan(0);

    const pinned = new Set(Object.keys(fixture.convexRefs));
    // A ref the hook calls but the fixture does not pin is exactly the gap
    // that let `shares:revokeAllShares` ship unpinned.
    for (const ref of new Set(called)) {
      expect(pinned.has(ref), `${ref} is called but not pinned`).toBe(true);
    }
    // And a pinned ref nothing calls is a stale contract entry.
    for (const ref of pinned) {
      expect(called.includes(ref), `${ref} is pinned but never called`).toBe(
        true,
      );
    }
  });

  it("pins arg names that appear in the hook's call sites", () => {
    for (const [ref, spec] of Object.entries(fixture.convexRefs)) {
      if (ref === "shares:getShareSettings") continue;
      for (const arg of (spec as { args: string[] }).args) {
        const name = arg.replace(/\?$/, "");
        if (name === "resourceType" || name === "resourceId") continue;
        expect(hookSource.includes(name), `${ref} arg ${name}`).toBe(true);
      }
    }
  });
});

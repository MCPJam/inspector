import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/share-envelope.json";

describe("share envelope contract fixture", () => {
  it("pins the five Convex refs and envelope keys", () => {
    expect(Object.keys(fixture.convexRefs)).toEqual([
      "shares:getShareSettings",
      "shares:setShareMode",
      "shares:rotateShareLink",
      "shares:upsertShareMember",
      "shares:removeShareMember",
    ]);
    expect(fixture.shareSettingsEnvelope).toMatchObject({
      resourceType: "conformanceRun",
      mode: "anyone_with_link",
      policyVersion: 1,
    });
    const disk = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../fixtures/share-envelope.json",
        ),
        "utf8",
      ),
    );
    expect(disk).toEqual(fixture);
  });
});

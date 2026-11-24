import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runGroupIdFor } from "../run-group-id.js";
import { deriveRunGroupId } from "../../../routes/v1/evals.js";

describe("runGroupIdFor", () => {
  it("is the first 32 hex digits of sha256 of the key under the suite, as the backend registers it", () => {
    const expected = createHash("sha256").update("eval-run-group:suite-1:climb:c1:baseline:1:baseline_a").digest("hex").slice(0, 32);
    expect(runGroupIdFor("suite-1", "climb:c1:baseline:1:baseline_a")).toBe(expected);
  });

  it("is the id the grouped launch route derives from the same key", () => {
    for (const key of ["climb:c1:round:3:candidate", "climb:c1:verification:2:restore"]) {
      expect(runGroupIdFor("suite-9", key)).toBe(deriveRunGroupId("suite-9", key));
    }
  });
});

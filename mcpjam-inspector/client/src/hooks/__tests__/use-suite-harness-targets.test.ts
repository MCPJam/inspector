import { describe, expect, it } from "vitest";
import { suiteClientHostIds } from "../use-suite-harness-targets";

describe("suiteClientHostIds", () => {
  it("reads an attachment suite's clients", () => {
    expect(
      suiteClientHostIds({
        hostAttachments: [{ namedHostId: "a" }, { namedHostId: "b" }],
      }),
    ).toEqual(["a", "b"]);
  });

  it("reads an environment suite's clients from its environments", () => {
    expect(
      suiteClientHostIds(
        {
          environmentIds: ["env-1", "env-2", "env-missing"],
          hostAttachments: [{ namedHostId: "ignored" }],
        },
        [
          { environmentId: "env-1", hostId: "a" },
          { environmentId: "env-2", hostId: "a" },
        ],
      ),
    ).toEqual(["a"]);
  });

  it("has no clients before the suite loads", () => {
    expect(suiteClientHostIds(undefined)).toEqual([]);
  });
});

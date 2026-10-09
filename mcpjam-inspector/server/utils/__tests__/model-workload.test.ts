import { describe, expect, it } from "vitest";
import { modelWorkloadFor } from "../model-workload";

describe("modelWorkloadFor", () => {
  it.each(["eval", "swarm", "scenario"])(
    "keeps %s unattended without leaking content",
    (sourceType) => {
      expect(
        modelWorkloadFor({
          sourceType,
          tools: { search: { secret: "private-schema" } },
          messages: [
            {
              role: "user",
              content: [{ type: "image", image: "private-image" }],
            },
          ],
        }),
      ).toEqual({ purpose: "evalTarget", hasTools: true, hasUserImages: true });
    },
  );
  it.each([
    [{ role: "user", parts: [{ type: "file", mediaType: "image/png" }] }, true],
    [
      { role: "user", content: [{ type: "file", mimeType: "image/jpeg" }] },
      true,
    ],
    [{ role: "tool", content: [{ type: "image" }] }, false],
    [
      {
        role: "user",
        content: [{ type: "file", mediaType: "application/pdf" }],
      },
      false,
    ],
    [null, false],
  ])("derives user image requirements from %j", (message, expected) => {
    expect(
      modelWorkloadFor({
        sourceType: "direct",
        tools: {},
        messages: [message],
      }),
    ).toEqual({ purpose: "chat", hasTools: false, hasUserImages: expected });
  });
});

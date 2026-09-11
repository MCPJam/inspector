import { expect, it } from "vitest";
import { collectSessionScreenshots } from "../browser-evidence.js";
import type { PlatformChatSessionTrace } from "../types.js";
it("keeps turn identity, skips unavailable captures, and filters failed calls", () => {
  const trace: PlatformChatSessionTrace = {
    sessionId: "session",
    origin: "api",
    traceVersion: 1,
    turnCount: 2,
    turns: [
      {
        turnId: "one",
        promptIndex: 0,
        startedAt: 0,
        endedAt: 1,
        spanCount: 0,
        screenshots: [
          { toolCallId: "call", stepIndex: 0, url: "https://a.test/image" },
        ],
      },
      {
        turnId: "two",
        promptIndex: 1,
        startedAt: 2,
        endedAt: 3,
        spanCount: 1,
        spans: [{ toolCallId: "call", status: "error" }],
        screenshots: [
          { toolCallId: "call", stepIndex: 0, url: "https://a.test/second" },
          { toolCallId: "missing", stepIndex: 0, status: "unavailable" },
        ],
      },
    ],
  };
  expect(collectSessionScreenshots(trace)).toHaveLength(2);
  expect(
    collectSessionScreenshots(trace, { failedOnly: true })[0]?.turnId
  ).toBe("two");
  expect(collectSessionScreenshots(trace, { limit: 0 })).toEqual([]);
});

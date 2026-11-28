import { beforeEach, describe, expect, it } from "vitest";
import { isToolNotificationDataPart } from "@/shared/tool-notification";
import {
  TOOL_LOG_LINES_KEPT,
  TOOL_RUNS_KEPT,
  useToolNotificationStore,
} from "../tool-notification-store";

beforeEach(() => useToolNotificationStore.setState({ runs: {} }));

describe("tool notification store", () => {
  it("keeps the latest progress and the last log lines of each call apart", () => {
    const { apply } = useToolNotificationStore.getState();
    apply({ toolCallId: "a", kind: "progress", progress: 1, total: 3 });
    apply({ toolCallId: "a", kind: "progress", progress: 2, total: 3 });
    apply({ toolCallId: "b", kind: "progress", progress: 9 });
    for (let i = 0; i < TOOL_LOG_LINES_KEPT + 5; i++) {
      apply({ toolCallId: "a", kind: "log", level: "info", text: `line ${i}` });
    }
    const { runs } = useToolNotificationStore.getState();
    expect(runs.a?.progress).toMatchObject({ progress: 2, total: 3 });
    expect(runs.a?.logs).toHaveLength(TOOL_LOG_LINES_KEPT);
    expect(runs.a?.logs.at(-1)?.text).toBe(`line ${TOOL_LOG_LINES_KEPT + 4}`);
    expect(runs.b?.progress?.progress).toBe(9);
  });

  it("keeps the calls heard from most recently and drops the quietest", () => {
    const { apply } = useToolNotificationStore.getState();
    const log = (toolCallId: string) =>
      apply({ toolCallId, kind: "log", level: "info", text: "working" });
    for (let i = 0; i < TOOL_RUNS_KEPT; i++) log(`call-${i}`);
    // call-0 is still running and is heard from again.
    log("call-0");
    log("call-new");
    const { runs } = useToolNotificationStore.getState();
    expect(Object.keys(runs)).toHaveLength(TOOL_RUNS_KEPT);
    expect(runs["call-0"]?.logs).toHaveLength(2);
    expect(runs["call-1"]).toBeUndefined();
    expect(runs["call-new"]).toBeDefined();
  });

  it("accepts only well-formed parts", () => {
    const good = {
      type: "data-tool-notification",
      data: { toolCallId: "a", kind: "progress", progress: 1 },
    };
    expect(isToolNotificationDataPart(good)).toBe(true);
    expect(
      isToolNotificationDataPart({ ...good, data: { toolCallId: "a", kind: "log", level: "info" } }),
    ).toBe(false);
    expect(isToolNotificationDataPart({ type: "data-other", data: good.data })).toBe(false);
    expect(isToolNotificationDataPart(null)).toBe(false);
  });
});

/**
 * Type-shape guard for the `checks` field added to `useChatSession`'s return.
 *
 * Two goals:
 *  1. Catch a regression where `checks` accidentally gets dropped from the
 *     return statement (the field would still exist on the interface, but
 *     consumers would see `undefined`).
 *  2. Document that adding `checks` is backward-compatible — existing
 *     consumers that destructure other fields (messages, sendMessage, …)
 *     keep working without touching `checks`.
 */
import { describe, expect, it, expectTypeOf } from "vitest";
import type {
  ChatSessionCheckRow,
  UseChatSessionReturn,
} from "@/hooks/use-chat-session";

describe("UseChatSessionReturn.checks", () => {
  it("declares checks as ChatSessionCheckRow[] | undefined", () => {
    expectTypeOf<UseChatSessionReturn["checks"]>().toEqualTypeOf<
      ChatSessionCheckRow[] | undefined
    >();
  });

  it("ChatSessionCheckRow covers running/completed/failed status union", () => {
    const runningRow: ChatSessionCheckRow = {
      _id: "r1",
      chatSessionId: "s1",
      status: "running",
      setKind: "suite_defaults",
      predicates: [],
    };
    const completedRow: ChatSessionCheckRow = {
      _id: "r2",
      chatSessionId: "s1",
      status: "completed",
      setKind: "ad_hoc",
      predicates: [],
      predicateResults: [],
    };
    const failedRow: ChatSessionCheckRow = {
      _id: "r3",
      chatSessionId: "s1",
      status: "failed",
      setKind: "case_resolved",
      predicates: [],
      errorMessage: "boom",
    };
    expect([runningRow.status, completedRow.status, failedRow.status]).toEqual([
      "running",
      "completed",
      "failed",
    ]);
  });
});

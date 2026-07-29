/**
 * The hosted task-created wire contract.
 *
 * The version test is the one that matters: this part must degrade silently
 * where MRTR fails fast, and the reason is asymmetric enough that it is worth
 * pinning rather than trusting a comment.
 */

import { describe, expect, it } from "vitest";
import {
  HOSTED_TASKS_VERSION,
  HOSTED_TASK_CREATED_DATA_PART_TYPE,
  isCompatibleHostedTasksVersion,
  isTaskCreatedDataPart,
  isTaskCreatedPayload,
} from "../hosted-task-created";

const valid = {
  taskId: "task-1",
  serverId: "srv_convex_id",
  serverName: "My Server",
  wire: "extension" as const,
};

describe("isTaskCreatedPayload", () => {
  it("accepts the minimal shape", () => {
    expect(isTaskCreatedPayload({ ...valid, serverName: undefined })).toBe(true);
  });

  it("rejects a missing or empty taskId", () => {
    expect(isTaskCreatedPayload({ ...valid, taskId: "" })).toBe(false);
    expect(isTaskCreatedPayload({ ...valid, taskId: undefined })).toBe(false);
  });

  it("rejects a wire that is not a live task wire", () => {
    // "none" is a resolved wire but never a task-bearing one.
    expect(isTaskCreatedPayload({ ...valid, wire: "none" })).toBe(false);
  });

  it("accepts a null ttlMs — no expiry is distinct from absent", () => {
    expect(isTaskCreatedPayload({ ...valid, ttlMs: null })).toBe(true);
    expect(isTaskCreatedPayload({ ...valid, ttlMs: 60_000 })).toBe(true);
    expect(isTaskCreatedPayload({ ...valid, ttlMs: "60s" })).toBe(false);
  });

  it("carries serverName, which the tracker keys by", () => {
    // Tracking under a Convex document id files the task where the Tasks tab
    // never looks, so the name has to survive the wire.
    const payload = { ...valid };
    expect(isTaskCreatedPayload(payload)).toBe(true);
    expect(payload.serverName).toBe("My Server");
  });
});

describe("isTaskCreatedDataPart", () => {
  it("matches the wire literal and validates the payload", () => {
    expect(
      isTaskCreatedDataPart({
        type: HOSTED_TASK_CREATED_DATA_PART_TYPE,
        data: valid,
      }),
    ).toBe(true);
  });

  it("rejects another part type carrying a valid payload", () => {
    expect(
      isTaskCreatedDataPart({ type: "data-mrtr-input-required", data: valid }),
    ).toBe(false);
  });
});

describe("version handshake", () => {
  it("matches exactly", () => {
    expect(isCompatibleHostedTasksVersion(HOSTED_TASKS_VERSION)).toBe(true);
    expect(isCompatibleHostedTasksVersion(HOSTED_TASKS_VERSION + 1)).toBe(false);
  });

  it("treats absent as incompatible rather than throwing", () => {
    // Absent means an old bundle. The caller's only correct response is to skip
    // the bridge — a task that already exists must not fail the turn that made
    // it, which is exactly where this diverges from MRTR's 409.
    expect(isCompatibleHostedTasksVersion(undefined)).toBe(false);
    expect(isCompatibleHostedTasksVersion(null)).toBe(false);
    expect(isCompatibleHostedTasksVersion("1")).toBe(false);
  });
});

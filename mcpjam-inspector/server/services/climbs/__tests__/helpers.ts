/** Fakes shared by the climb service tests. */
import { vi } from "vitest";
import { getFunctionName } from "convex/server";
import { runGroupIdFor } from "../run-group-id.js";
import type { RegisteredGroup } from "../launch-unit.js";

export const SUITE = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
export const CLIMB = "climb1xxxxxxxxxxxxxxxxxxxxxxxxxx";

/** A group the backend registered: its id follows from its key, as the backend derives it. */
export function registered(role: string, over: Partial<RegisteredGroup> = {}): RegisteredGroup {
  const idempotencyKey = `climb:${CLIMB}:baseline:1:${role}`;
  return {
    role,
    runGroupId: runGroupIdFor(SUITE, idempotencyKey),
    idempotencyKey,
    deadlineAt: 1_000,
    serverId: "s_mock",
    serverVersion: "1",
    environmentIds: ["env_a", "env_b"],
    caseIds: ["case_1", "case_2"],
    status: "registered",
    ...over,
  };
}

/** A grouped-launch receipt in which every environment started. */
export function startedReceipt(group: RegisteredGroup, prefix = group.role) {
  const targets = group.environmentIds.map((environmentId) => ({
    status: "started" as const,
    target: { environmentId },
    runId: `${prefix}-${environmentId}`,
    runStatus: "running",
  }));
  return {
    runGroupId: group.runGroupId,
    suiteId: SUITE,
    outcome: "started" as const,
    startedCount: targets.length,
    failedCount: 0,
    targets,
  };
}

export const nameOf = (ref: unknown) => getFunctionName(ref as never);

/** A Convex stand-in that answers each function by name and records every call. */
export function fakeConvex(
  handlers: Record<string, (args: Record<string, any>) => unknown> = {},
) {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const run = async (ref: unknown, args: Record<string, any>) => {
    const name = nameOf(ref);
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected call ${name}`);
    return handler(args);
  };
  return {
    calls,
    convex: { query: vi.fn(run), mutation: vi.fn(run) } as never,
    called: (name: string) => calls.filter((call) => call.name === name).map((call) => call.args),
  };
}

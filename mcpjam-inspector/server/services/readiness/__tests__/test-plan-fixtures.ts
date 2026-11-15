/**
 * A sample server, a plan for it that the SDK validates, an in-memory call
 * ledger and a scripted server, shared by the test plan executor and run
 * tests.
 *
 * The plan reads an existing project, creates a scratch project, renames and
 * deletes it, refuses an email tool, and cleans the scratch project up.
 */

import { vi } from "vitest";
import type {
  DirectoryTestCallRecord,
  DirectoryTestPlan,
  DirectoryTestPlanTool,
  DirectoryToolCallEvidence,
} from "@mcpjam/sdk";
import {
  toCallRecord,
  type LedgerAnswer,
  type LedgerCallWrite,
} from "../call-ledger.js";
import type { TestPlanCallRequest } from "../test-plan-executor.js";

const requires = (...required: string[]) => ({
  type: "object",
  properties: Object.fromEntries(
    required.map((key) => [key, { type: "string" }]),
  ),
  required,
});

export const TOOLS: DirectoryTestPlanTool[] = [
  { name: "list_projects", annotations: { readOnlyHint: true } },
  {
    name: "get_project",
    annotations: { readOnlyHint: true },
    inputSchema: requires("projectId"),
  },
  {
    name: "create_project",
    annotations: { destructiveHint: false, openWorldHint: false },
    inputSchema: requires("name"),
  },
  {
    name: "rename_project",
    annotations: { destructiveHint: false, openWorldHint: false },
    inputSchema: requires("projectId", "name"),
  },
  {
    name: "delete_project",
    annotations: { destructiveHint: true, openWorldHint: false },
    inputSchema: requires("projectId"),
  },
  {
    name: "send_invite",
    annotations: { destructiveHint: false, openWorldHint: true },
    inputSchema: requires("email"),
  },
];

const demo = { $fixture: "demoProject", value: "id" };
const scratch = { $fixture: "scratchProject", value: "id" };

export function samplePlan(): DirectoryTestPlan {
  const writes = ["scratchProject"];
  return {
    schemaVersion: 1,
    fixtures: [
      {
        id: "demoProject",
        description: "The project the reviewer account starts with.",
        origin: "existing",
        values: { id: "proj_demo" },
      },
      {
        id: "scratchProject",
        description: "A project the sweep creates and deletes.",
        origin: "created",
        capture: { id: "project.id" },
      },
    ],
    tools: [
      {
        tool: "list_projects",
        effect: "read",
        openWorld: false,
        action: "run",
        writes: [],
      },
      {
        tool: "get_project",
        effect: "read",
        openWorld: false,
        action: "run",
        writes: [],
      },
      {
        tool: "create_project",
        effect: "write",
        openWorld: false,
        action: "run",
        writes,
      },
      {
        tool: "rename_project",
        effect: "write",
        openWorld: false,
        action: "run",
        writes,
      },
      {
        tool: "delete_project",
        effect: "destructive",
        openWorld: false,
        action: "run",
        writes,
      },
      {
        tool: "send_invite",
        effect: "write",
        openWorld: true,
        action: "excluded",
        exclusion: {
          reason: "external-effects",
          note: "It emails a real person.",
        },
        writes: [],
      },
    ],
    cases: [
      {
        id: "list_projects#valid",
        tool: "list_projects",
        kind: "valid",
        arguments: {},
      },
      {
        id: "get_project#valid",
        tool: "get_project",
        kind: "valid",
        arguments: { projectId: demo },
      },
      {
        id: "get_project#missing-id",
        tool: "get_project",
        kind: "negative",
        arguments: {},
      },
      {
        id: "create_project#valid",
        tool: "create_project",
        kind: "valid",
        arguments: { name: "Readiness scratch" },
        creates: ["scratchProject"],
      },
      {
        id: "rename_project#valid",
        tool: "rename_project",
        kind: "valid",
        arguments: { projectId: scratch, name: "Renamed by MCPJam" },
      },
      {
        id: "delete_project#valid",
        tool: "delete_project",
        kind: "valid",
        arguments: { projectId: scratch },
      },
    ],
    budget: { maxCalls: 20, concurrency: 1, callTimeoutMs: 5_000 },
    cleanup: [
      {
        fixture: "scratchProject",
        tool: "delete_project",
        arguments: { projectId: scratch },
      },
    ],
  };
}

export const OK: DirectoryToolCallEvidence = {
  status: 200,
  result: { isError: false },
};

/**
 * How the sample server answers: a result for everything, the new project's
 * id for a create, and a tool error for `get_project` with no id.
 */
export function sampleAnswer(
  request: TestPlanCallRequest,
): DirectoryToolCallEvidence {
  if (request.tool === "create_project") {
    return { ...OK, captured: { "project.id": "proj_scratch" } };
  }
  if (request.tool === "get_project" && !request.arguments.projectId) {
    return { status: 200, result: { isError: true } };
  }
  return OK;
}

/** One line per ledger write and per call sent, in the order they happened. */
export type Journal = string[];

/** A server that answers as `answer` says and journals each call it gets. */
export function scriptedServer(
  journal: Journal,
  answer: (
    request: TestPlanCallRequest,
  ) =>
    | DirectoryToolCallEvidence
    | Promise<DirectoryToolCallEvidence> = sampleAnswer,
) {
  const sent: TestPlanCallRequest[] = [];
  const send = vi.fn(async (request: TestPlanCallRequest) => {
    sent.push(request);
    journal.push(`send ${request.tool}`);
    return answer(request);
  });
  return { send, sent };
}

/**
 * A ledger that takes every write, as the backend does for one job holding
 * the lease, and journals it.
 */
export function memoryLedger(
  journal: Journal,
  initial: DirectoryTestCallRecord[] = [],
) {
  const rows = new Map(initial.map((call) => [call.callKey, call]));
  const writes: LedgerCallWrite[] = [];
  const record = vi.fn(
    async (write: LedgerCallWrite): Promise<LedgerAnswer> => {
      writes.push(write);
      journal.push(`${write.phase} ${write.callKey}`);
      const call = toCallRecord(write);
      if (!call) throw new Error(`unreadable write for ${write.callKey}`);
      rows.set(write.callKey, call);
      return { kind: "recorded", call };
    },
  );
  return { rows, writes, record };
}

/** A ledger row as an earlier execution of the run left it. */
export function storedCall(
  callKey: string,
  tool: string,
  inputDigest: string,
  rest: Partial<DirectoryTestCallRecord> = {},
): DirectoryTestCallRecord {
  return {
    callKey,
    tool,
    phase: "started",
    inputDigest,
    ranBy: { kind: "direct-call" },
    startedAt: 1_000,
    ...rest,
  };
}

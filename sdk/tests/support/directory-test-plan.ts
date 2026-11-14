/**
 * A sample server's tool list and a plan for it that passes validation,
 * shared by the test-plan draft, validation and outcome tests.
 *
 * The tools cover every annotation case the draft reads: read-only, additive
 * write, destructive, open-world, and a tool with no annotations at all. They
 * are listed out of order on purpose, so the draft has to sort them.
 */

import { orderDirectoryTestCases } from "../../src/directory-readiness/test-plan/draft.js";
import type {
  DirectoryTestCase,
  DirectoryTestPlan,
  DirectoryTestPlanTool,
  DirectoryToolPlan,
} from "../../src/directory-readiness/test-plan/types.js";

const requires = (...required: string[]) => ({
  type: "object",
  properties: Object.fromEntries(
    required.map((key) => [key, { type: "string" }])
  ),
  required,
});

export const SAMPLE_TOOLS: DirectoryTestPlanTool[] = [
  {
    name: "delete_project",
    annotations: { destructiveHint: true, openWorldHint: false },
    inputSchema: requires("projectId"),
  },
  {
    name: "send_invite",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: requires("email"),
  },
  {
    name: "get_project",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: requires("projectId"),
  },
  // No annotations: MCP's defaults make it destructive and open world.
  { name: "purge_cache" },
  {
    name: "create_project",
    annotations: { destructiveHint: false, openWorldHint: false },
    inputSchema: requires("name"),
  },
  {
    name: "search_web",
    annotations: { readOnlyHint: true },
    inputSchema: requires("query"),
  },
  {
    name: "list_projects",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rename_project",
    annotations: { destructiveHint: false, openWorldHint: false },
    inputSchema: requires("projectId", "name"),
  },
];

export const scratch = { $fixture: "scratchProject", value: "id" };

function tool(
  name: string,
  effect: DirectoryToolPlan["effect"],
  rest: Partial<DirectoryToolPlan> = {}
): DirectoryToolPlan {
  return {
    tool: name,
    effect,
    openWorld: false,
    action: "run",
    writes: [],
    ...rest,
  };
}

function valid(
  name: string,
  args: Record<string, unknown>,
  rest: Partial<DirectoryTestCase> = {}
): DirectoryTestCase {
  return {
    id: `${name}#valid`,
    tool: name,
    kind: "valid",
    arguments: args,
    ...rest,
  };
}

/**
 * A plan a person could authorize: a project created for the sweep, read,
 * renamed and deleted inside that fixture, an existing project only read,
 * and the two tools that reach past the server excluded with a reason.
 */
export function completePlan(): DirectoryTestPlan {
  const tools = [
    tool("delete_project", "destructive", { writes: ["scratchProject"] }),
    tool("send_invite", "write", {
      openWorld: true,
      action: "excluded",
      exclusion: {
        reason: "external-effects",
        note: "It emails a real person.",
      },
    }),
    tool("get_project", "read"),
    tool("purge_cache", "destructive", {
      openWorld: true,
      action: "excluded",
      exclusion: { reason: "costly" },
    }),
    tool("create_project", "write", { writes: ["scratchProject"] }),
    tool("search_web", "read", { openWorld: true }),
    tool("list_projects", "read"),
    tool("rename_project", "write", { writes: ["scratchProject"] }),
  ];
  const cases: DirectoryTestCase[] = [
    valid("delete_project", { projectId: scratch }),
    valid("get_project", {
      projectId: { $fixture: "demoProject", value: "id" },
    }),
    {
      id: "get_project#missing-arguments",
      tool: "get_project",
      kind: "negative",
      arguments: {},
    },
    valid(
      "create_project",
      { name: "Readiness scratch" },
      { creates: ["scratchProject"] }
    ),
    valid("search_web", { query: "model context protocol" }),
    valid("list_projects", {}),
    valid("rename_project", { projectId: scratch, name: "Renamed by MCPJam" }),
  ];
  const plan: DirectoryTestPlan = {
    schemaVersion: 1,
    fixtures: [
      {
        id: "demoProject",
        description: "The demo project the reviewer account starts with.",
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
    tools,
    cases,
    budget: { maxCalls: 20, concurrency: 1, callTimeoutMs: 30_000 },
    cleanup: [
      {
        fixture: "scratchProject",
        tool: "delete_project",
        arguments: { projectId: scratch },
      },
    ],
  };
  return { ...plan, cases: orderDirectoryTestCases(plan) };
}

export function caseIds(cases: readonly DirectoryTestCase[]): string[] {
  return cases.map((testCase) => testCase.id);
}

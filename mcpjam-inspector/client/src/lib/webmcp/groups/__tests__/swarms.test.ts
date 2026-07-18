/**
 * The swarms group's own contract: exact tool set, honest annotations (the
 * destructive set is exactly the launch tool — it fans out sessions and spends
 * quota), dispatch shapes, and the billing/quota command error passing through
 * as a tool error. The 402→"execution_failed" mapping itself lives in
 * SwarmsTab's handler (see SwarmsTab.agent.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorCommandResponse } from "@/shared/inspector-command.js";

const { dispatchInspectorCommandMock } = vi.hoisted(() => ({
  dispatchInspectorCommandMock: vi.fn(),
}));

vi.mock("../../ui-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui-actions")>();
  return { ...actual, dispatchInspectorCommand: dispatchInspectorCommandMock };
});

import { buildSwarmsUiTools } from "../swarms";

const SWARMS_TOOL_NAMES = [
  "ui_create_persona",
  "ui_open_journey_form",
  "ui_launch_swarm_run",
];

function getTool(name: string) {
  const tool = buildSwarmsUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`swarms group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildSwarmsUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the three swarms tools", () => {
    expect(buildSwarmsUiTools().map((t) => t.name)).toEqual(SWARMS_TOOL_NAMES);
  });

  it("annotates every tool completely and honestly", () => {
    // create persona: direct low-entropy commit, stays inside MCPJam, creates
    // a new row each time → not idempotent.
    expect(getTool("ui_create_persona").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    // open journey form: prepares only (prefill-over-commit), no spend.
    expect(getTool("ui_open_journey_form").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    // launch: fans out sessions, spends quota, drives real MCP traffic →
    // destructive + open-world, and a deliberate re-invocation is a new run.
    expect(getTool("ui_launch_swarm_run").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    for (const tool of buildSwarmsUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("gates exactly the launch tool behind the destructive approval pill", () => {
    const destructive = buildSwarmsUiTools()
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual(["ui_launch_swarm_run"]);
  });

  it("launch declares its spend in the description", () => {
    expect(getTool("ui_launch_swarm_run").description).toMatch(/spend/i);
    expect(getTool("ui_launch_swarm_run").description).toMatch(/quota/i);
  });

  it("ui_create_persona dispatches createPersona and requires name + role", async () => {
    await getTool("ui_create_persona").execute({
      name: "Impatient buyer",
      role: "customer",
      notes: "always in a hurry",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "createPersona",
      payload: {
        name: "Impatient buyer",
        role: "customer",
        notes: "always in a hurry",
      },
    });

    dispatchInspectorCommandMock.mockClear();
    const noRole = await getTool("ui_create_persona").execute({
      name: "Impatient buyer",
    });
    expect(noRole.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();

    const noName = await getTool("ui_create_persona").execute({
      role: "customer",
    });
    expect(noName.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_open_journey_form dispatches openJourneyForm with optional persona + goal", async () => {
    await getTool("ui_open_journey_form").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "openJourneyForm",
      payload: {},
    });

    await getTool("ui_open_journey_form").execute({
      persona: "Impatient buyer",
      goal: "Book a flight to Tokyo",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "openJourneyForm",
      payload: { persona: "Impatient buyer", goal: "Book a flight to Tokyo" },
    });
  });

  it("ui_open_journey_form rejects a non-string goal without dispatching", async () => {
    const result = await getTool("ui_open_journey_form").execute({ goal: 42 });
    expect(result.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_launch_swarm_run dispatches launchSwarmRun and requires 'journey'", async () => {
    await getTool("ui_launch_swarm_run").execute({ journey: "Book a flight" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "launchSwarmRun",
      payload: { journey: "Book a flight" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_launch_swarm_run").execute({
      journey: "   ",
    });
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_launch_swarm_run surfaces a billing/quota command error as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "execution_failed",
        message:
          "Cannot launch this journey run: Swarm run limit reached. Launching spends the organization's swarm quota, which is exhausted — do not retry until it resets or billing is updated.",
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_launch_swarm_run").execute({
      journey: "Book a flight",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("execution_failed");
    expect(result.content[0].text).toContain("swarm quota");
  });

  it("surfaces unknown-entity command errors (invalid_request) as tool errors", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "invalid_request",
        message: 'No journey matches "Nope".',
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_launch_swarm_run").execute({
      journey: "Nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_request");
  });
});

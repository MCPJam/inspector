/**
 * The scenarios group's own contract: exact tool set, honest annotations (the
 * destructive set is exactly delete — irreversible is irreversible; publish
 * creates a share surface and converges, so it is idempotent), dispatch
 * shapes, in-execute validation, and command errors passing through as tool
 * errors. Resolving an environment/scenario to a row lives in UserTestingTab's
 * handlers (see UserTestingTab.agent.test.tsx).
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

import { buildScenariosUiTools } from "../scenarios";

const SCENARIO_TOOL_NAMES = ["ui_publish_scenario", "ui_delete_scenario"];

function getTool(name: string) {
  const tool = buildScenariosUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`scenarios group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildScenariosUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the two scenario tools", () => {
    expect(buildScenariosUiTools().map((t) => t.name)).toEqual(
      SCENARIO_TOOL_NAMES,
    );
  });

  it("annotates every tool completely and honestly", () => {
    // publish: provisions (creates) rather than wipes; re-publishing converges
    // → idempotent, not destructive. Stays inside MCPJam.
    expect(getTool("ui_publish_scenario").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // delete: irreversible → destructive; deleting a gone scenario fails cleanly.
    expect(getTool("ui_delete_scenario").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of buildScenariosUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("gates exactly delete behind the destructive approval pill", () => {
    const destructive = buildScenariosUiTools()
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual(["ui_delete_scenario"]);
  });

  it("keeps share tokens/secrets out of every input schema", () => {
    for (const tool of buildScenariosUiTools()) {
      const json = JSON.stringify(tool).toLowerCase();
      expect(json).not.toContain("token");
      expect(json).not.toContain("secret");
      expect(json).not.toContain("transcript");
    }
  });

  it("ui_publish_scenario dispatches publishScenario for an ENVIRONMENT", async () => {
    await getTool("ui_publish_scenario").execute({
      environment: "Checkout flow",
      access: "link_guests",
      name: "Round 1",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "publishScenario",
      payload: {
        environment: "Checkout flow",
        access: "link_guests",
        name: "Round 1",
      },
    });
  });

  it("ui_publish_scenario omits absent optionals rather than sending empties", async () => {
    // An empty string would be applied as the scenario's NAME.
    await getTool("ui_publish_scenario").execute({
      environment: "Checkout flow",
      name: "   ",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "publishScenario",
      payload: { environment: "Checkout flow" },
    });
  });

  it("ui_publish_scenario validates in code, so the model can self-correct", async () => {
    const missing = await getTool("ui_publish_scenario").execute({
      environment: "  ",
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("environment");

    const badAccess = await getTool("ui_publish_scenario").execute({
      environment: "Checkout flow",
      access: "public",
    });
    expect(badAccess.isError).toBe(true);
    // Names the accepted values rather than just refusing.
    expect(badAccess.content[0].text).toContain("invited_only");
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_delete_scenario dispatches deleteScenario for a SCENARIO", async () => {
    await getTool("ui_delete_scenario").execute({ scenario: "Checkout flow" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "deleteScenario",
      payload: { scenario: "Checkout flow" },
    });

    dispatchInspectorCommandMock.mockClear();
    const missing = await getTool("ui_delete_scenario").execute({});
    expect(missing.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("surfaces the environments-off refusal (unsupported_in_mode) as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "unsupported_in_mode",
        message:
          "Publishing a scenario needs Environments, which isn't enabled for this project.",
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_publish_scenario").execute({
      environment: "Checkout flow",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsupported_in_mode");
    expect(result.content[0].text).toContain("Environments");
  });

  it("surfaces an unknown-target command error (invalid_request) as a tool error", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "invalid_request",
        message: 'No scenario matches "Nope".',
      },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_delete_scenario").execute({
      scenario: "Nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_request");
  });
});

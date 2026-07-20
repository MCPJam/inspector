/**
 * The oauth-flow group's own contract: exact tool set, honest annotations
 * (the destructive set is exactly the advance tool — one step can POST a
 * persistent DCR registration to a third-party AS), dispatch shapes, and
 * command errors passing through as tool errors. The handler-side gate
 * behavior (no profile / in-flight / complete) lives in OAuthFlowTab's
 * handlers (see OAuthFlowTab.agent.test.tsx).
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

import { buildOAuthFlowUiTools } from "../oauth-flow";

const OAUTH_FLOW_TOOL_NAMES = [
  "ui_open_oauth_server_config",
  "ui_advance_oauth_flow",
  "ui_reset_oauth_flow",
];

function getTool(name: string) {
  const tool = buildOAuthFlowUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`oauth-flow group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildOAuthFlowUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the three oauth-flow tools", () => {
    expect(buildOAuthFlowUiTools().map((t) => t.name)).toEqual(
      OAUTH_FLOW_TOOL_NAMES,
    );
  });

  it("annotates every tool completely and honestly", () => {
    // open config: prefill-over-commit, converges on the same open modal.
    expect(getTool("ui_open_oauth_server_config").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // advance: one step can create a persistent third-party client
    // registration and always drives real third-party HTTP; each call is a
    // distinct step.
    expect(getTool("ui_advance_oauth_flow").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    // reset: local re-runnable debug state; double-reset converges.
    expect(getTool("ui_reset_oauth_flow").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const tool of buildOAuthFlowUiTools()) {
      expect(tool.readOnly).toBe(tool.annotations?.readOnlyHint);
    }
  });

  it("gates exactly the advance tool behind the destructive approval pill", () => {
    const destructive = buildOAuthFlowUiTools()
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual(["ui_advance_oauth_flow"]);
  });

  it("advance declares one-step, human sign-in, and third-party registration in its description", () => {
    const description = getTool("ui_advance_oauth_flow").description;
    expect(description).toMatch(/ONE protocol step/);
    expect(description).toMatch(/HUMAN must complete/);
    expect(description).toMatch(/popup blocker/i);
    expect(description).toMatch(/persistent/i);
  });

  it("open-config declares that credentials cannot be passed", () => {
    const { description, inputSchema } = getTool(
      "ui_open_oauth_server_config",
    );
    expect(description).toMatch(/typed by the human/i);
    // No credential fields in the schema — the no-secrets-in-schemas rule.
    const properties = (inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).toEqual([
      "serverName",
      "serverUrl",
      "registrationMode",
    ]);
  });

  it("ui_open_oauth_server_config dispatches openOauthServerConfig with only provided fields", async () => {
    await getTool("ui_open_oauth_server_config").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "openOauthServerConfig",
      payload: {},
    });

    await getTool("ui_open_oauth_server_config").execute({
      serverName: "linear",
      serverUrl: "https://mcp.linear.app/mcp",
      registrationMode: "dcr",
    });
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "openOauthServerConfig",
      payload: {
        serverName: "linear",
        serverUrl: "https://mcp.linear.app/mcp",
        registrationMode: "dcr",
      },
    });
  });

  it("ui_open_oauth_server_config rejects bad input without dispatching", async () => {
    const badMode = await getTool("ui_open_oauth_server_config").execute({
      registrationMode: "bogus",
    });
    expect(badMode.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();

    const badName = await getTool("ui_open_oauth_server_config").execute({
      serverName: 42,
    });
    expect(badName.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();

    const badUrl = await getTool("ui_open_oauth_server_config").execute({
      serverUrl: "   ",
    });
    expect(badUrl.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("ui_advance_oauth_flow and ui_reset_oauth_flow dispatch empty payloads", async () => {
    await getTool("ui_advance_oauth_flow").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "advanceOauthFlow",
      payload: {},
    });

    await getTool("ui_reset_oauth_flow").execute({});
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "resetOauthFlow",
      payload: {},
    });
  });

  it("surfaces command errors as tool errors with their code", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "invalid_request",
        message: "The flow is already complete — use ui_reset_oauth_flow.",
      },
    } satisfies InspectorCommandResponse);
    const invalid = await getTool("ui_advance_oauth_flow").execute({});
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("invalid_request");

    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: {
        code: "execution_failed",
        message: "A protocol step is already in flight.",
      },
    } satisfies InspectorCommandResponse);
    const busy = await getTool("ui_advance_oauth_flow").execute({});
    expect(busy.isError).toBe(true);
    expect(busy.content[0].text).toContain("execution_failed");
  });
});

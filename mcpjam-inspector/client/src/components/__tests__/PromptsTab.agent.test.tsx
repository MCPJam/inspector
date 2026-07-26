/**
 * PromptsTab agent bridge handler (S8). The getPrompt command is dispatched
 * through the real command bus against a mounted PromptsTab; the list/get APIs
 * are mocked so the handler acts through the SAME getPromptApi path the Run
 * button uses.
 *
 * Findings this pins:
 * - getPrompt resolves a prompt by name and renders it with the given args;
 * - an unknown prompt → invalid_request (no render); a failed render →
 *   execution_failed;
 * - no server / disconnected → unsupported_in_mode (no render);
 * - the returned content is TRUNCATED for the transcript; the snapshot reports
 *   presence/size + argument FIELD NAMES only, never the rendered body.
 */
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import { MAX_RESULT_CHARS } from "@/lib/webmcp/groups/shared";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { McpRequestError } from "@/lib/apis/insufficient-scope";
import { __resetScopeStepUpInFlightForTests } from "@/lib/scope-step-up";
import type { ServerWithName } from "@/state/app-types";

const SECRET_BODY = "SECRET-PROMPT-BODY-do-not-leak";

const { mockListPrompts, mockGetPrompt } = vi.hoisted(() => ({
  mockListPrompts: vi.fn(),
  mockGetPrompt: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-prompts-api", () => ({
  listPrompts: (...a: unknown[]) => mockListPrompts(...a),
  getPrompt: (...a: unknown[]) => mockGetPrompt(...a),
}));
vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <div data-testid="json-editor" />,
}));
vi.mock("@/components/logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view" />,
}));

const { mockApplyToolCallStepUp, mockResetToolCallStepUp } = vi.hoisted(() => ({
  mockApplyToolCallStepUp: vi.fn(),
  mockResetToolCallStepUp: vi.fn(),
}));
vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: (...a: unknown[]) => mockApplyToolCallStepUp(...a),
  resetToolCallStepUp: (...a: unknown[]) => mockResetToolCallStepUp(...a),
}));

import { PromptsTab } from "@/components/PromptsTab";

const serverConfig = {
  transportType: "stdio",
  command: "node",
  args: ["server.js"],
} as MCPServerConfig;

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `prompt-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

async function renderLoaded(props?: {
  status?: "connected" | "disconnected";
  server?: ServerWithName;
}) {
  render(
    <PromptsTab
      serverConfig={serverConfig}
      serverName="srv"
      serverConnectionStatus={props?.status ?? "connected"}
      server={props?.server}
    />,
  );
  if (props?.status === "disconnected") return;
  await waitFor(async () => {
    const snap: any = await readSurfaceSnapshot("prompts");
    expect(snap.ok && snap.data.promptCount).toBe(1);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListPrompts.mockResolvedValue([
    {
      name: "summarize",
      title: "Summarize",
      arguments: [{ name: "topic", required: true }],
    },
  ]);
  mockGetPrompt.mockResolvedValue({
    content: {
      messages: [{ role: "user", content: { type: "text", text: SECRET_BODY } }],
    },
  });
});

describe("PromptsTab — agent bridge handler", () => {
  it("renders a prompt by name with the given arguments through getPromptApi", async () => {
    await renderLoaded();
    const response = await dispatch({
      type: "getPrompt",
      payload: { prompt: "summarize", arguments: { topic: "MCP" } },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "prompt_rendered", prompt: "summarize" },
    });
    expect(mockGetPrompt).toHaveBeenCalledWith("srv", "summarize", {
      topic: "MCP",
    });
  });

  it("rejects an unknown prompt as invalid_request (no render)", async () => {
    await renderLoaded();
    const response = await dispatch({
      type: "getPrompt",
      payload: { prompt: "nope" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(mockGetPrompt).not.toHaveBeenCalled();
  });

  it("maps a failed render to execution_failed", async () => {
    await renderLoaded();
    mockGetPrompt.mockRejectedValue(new Error("boom"));
    const response = await dispatch({
      type: "getPrompt",
      payload: { prompt: "summarize", arguments: { topic: "x" } },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
  });

  it("refuses when the server is disconnected (no render)", async () => {
    await renderLoaded({ status: "disconnected" });
    const response = await dispatch({
      type: "getPrompt",
      payload: { prompt: "summarize" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect(mockGetPrompt).not.toHaveBeenCalled();
  });

  it("truncates a huge render and keeps the full body out of the snapshot", async () => {
    mockGetPrompt.mockResolvedValue({
      content: {
        messages: [
          { role: "user", content: { type: "text", text: SECRET_BODY.repeat(2000) } },
        ],
      },
    });
    await renderLoaded();
    const response = await dispatch({
      type: "getPrompt",
      payload: { prompt: "summarize", arguments: { topic: "x" } },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "prompt_rendered", truncated: true },
    });

    const snapshot = await readSurfaceSnapshot("prompts");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SECRET_BODY);
    expect((snapshot as any).data.lastResult.present).toBe(true);
    expect((snapshot as any).data.lastResult.approxSizeBytes).toBeGreaterThan(
      MAX_RESULT_CHARS,
    );
    // Argument FIELD NAMES are exposed; values never are.
    expect((snapshot as any).data.selectedPromptArgumentNames).toContain(
      "topic",
    );
  });
});


/** The resolved server entry the step-up lifecycle needs. */
const stepUpServer = { name: "srv" } as unknown as ServerWithName;

describe("PromptsTab — agent-driven step-up lifecycle (SEP-2350)", () => {
  // The defect these pin: the agent handler called the same API as the button
  // while skipping the step-up lifecycle entirely, so an agent-triggered
  // `403 insufficient_scope` could not start a re-authorization, and an
  // agent-triggered success left the bounded budget stale for a later,
  // legitimate step-up on another screen.
  beforeEach(() => {
    __resetScopeStepUpInFlightForTests();
  });

  it("drives the step-up when an agent-driven render hits a 403", async () => {
    mockGetPrompt.mockRejectedValueOnce(
      new McpRequestError("Forbidden", {
        status: 403,
        insufficientScope: { requiredScope: "files:write" },
      }),
    );
    await renderLoaded({ server: stepUpServer });
    const response = await dispatch({
      type: "getPrompt",
      payload: { prompt: "summarize", arguments: { topic: "MCP" } },
    });
    // The failure is still reported to the agent exactly as before …
    expect(response).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
    // … and the re-authorization is now actually driven.
    expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
    expect(mockApplyToolCallStepUp.mock.calls[0][1]).toMatchObject({
      requiredScope: "files:write",
    });
  });

  it("resets the budget when an agent-driven render succeeds", async () => {
    await renderLoaded({ server: stepUpServer });
    const response = await dispatch({
      type: "getPrompt",
      payload: { prompt: "summarize", arguments: { topic: "MCP" } },
    });
    expect(response).toMatchObject({ status: "success" });
    // A stale budget would otherwise suppress a later legitimate step-up.
    expect(mockResetToolCallStepUp).toHaveBeenCalledWith(stepUpServer);
  });

  it("leaves an ordinary failure alone", async () => {
    mockGetPrompt.mockRejectedValueOnce(new Error("network down"));
    await renderLoaded({ server: stepUpServer });
    await dispatch({
      type: "getPrompt",
      payload: { prompt: "summarize", arguments: { topic: "MCP" } },
    });
    expect(mockApplyToolCallStepUp).not.toHaveBeenCalled();
    expect(mockResetToolCallStepUp).not.toHaveBeenCalled();
  });
});

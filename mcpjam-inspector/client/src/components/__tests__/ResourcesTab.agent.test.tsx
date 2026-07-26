/**
 * ResourcesTab agent bridge handler (S8). The readResource command is
 * dispatched through the real command bus against a mounted ResourcesTab; the
 * list/read APIs are mocked so the handler acts through the SAME readResourceApi
 * path the Read button uses.
 *
 * Findings this pins:
 * - readResource resolves a CONCRETE resource by uri/name and reads it;
 * - it resolves a TEMPLATE, expands RFC 6570 params, and reads the resolved uri;
 * - a template missing required params → invalid_request (no read);
 * - an unknown resource → invalid_request; a failed read → execution_failed;
 * - no server / disconnected → unsupported_in_mode (no read);
 * - the returned content is TRUNCATED for the transcript; the snapshot reports
 *   presence/size only and never the resource body.
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

const SECRET_BODY = "SECRET-RESOURCE-BODY-do-not-leak";

const { mockListResources, mockReadResource, mockListTemplates } = vi.hoisted(
  () => ({
    mockListResources: vi.fn(),
    mockReadResource: vi.fn(),
    mockListTemplates: vi.fn(),
  }),
);

vi.mock("@/lib/apis/mcp-resources-api", () => ({
  listResources: (...a: unknown[]) => mockListResources(...a),
  readResource: (...a: unknown[]) => mockReadResource(...a),
}));
vi.mock("@/lib/apis/mcp-resource-templates-api", () => ({
  listResourceTemplates: (...a: unknown[]) => mockListTemplates(...a),
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

import { ResourcesTab } from "@/components/ResourcesTab";

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
      id: `resource-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

async function renderLoaded(props?: {
  serverName?: string;
  status?: "connected" | "disconnected";
  server?: ServerWithName;
}) {
  render(
    <ResourcesTab
      serverConfig={serverConfig}
      serverName={props?.serverName ?? "srv"}
      serverConnectionStatus={props?.status ?? "connected"}
      server={props?.server}
    />,
  );
  if (props?.status === "disconnected") return;
  await waitFor(async () => {
    const snap: any = await readSurfaceSnapshot("resources");
    expect(snap.ok && snap.data.resourceCount).toBe(1);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListResources.mockResolvedValue({
    resources: [{ uri: "file:///a.txt", name: "Alpha" }],
  });
  mockListTemplates.mockResolvedValue([
    { name: "greeting", uriTemplate: "greeting://{name}" },
    { name: "search", uriTemplate: "search{?q,limit}" },
  ]);
  mockReadResource.mockResolvedValue({
    content: { contents: [{ type: "text", text: SECRET_BODY }] },
  });
});

describe("ResourcesTab — agent bridge handler", () => {
  it("reads a concrete resource by name through readResourceApi", async () => {
    await renderLoaded();
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "Alpha" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "resource_read", uri: "file:///a.txt" },
    });
    expect(mockReadResource).toHaveBeenCalledWith("srv", "file:///a.txt");
  });

  it("resolves a template, expands params, and reads the resolved uri", async () => {
    await renderLoaded();
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "greeting", templateArguments: { name: "Ada" } },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "resource_read", uri: "greeting://Ada" },
    });
    expect(mockReadResource).toHaveBeenCalledWith("srv", "greeting://Ada");
  });

  it("reads a template with only some OPTIONAL query variables supplied", async () => {
    // search{?q,limit}: RFC 6570 query expansion — optional. The on-screen Read
    // allows omitting `limit`, so the agent must too (expand drops it).
    await renderLoaded();
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "search", templateArguments: { q: "mcp" } },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "resource_read", uri: "search?q=mcp" },
    });
    expect(mockReadResource).toHaveBeenCalledWith("srv", "search?q=mcp");
  });

  it("rejects a template with missing params as invalid_request (no read)", async () => {
    await renderLoaded();
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "greeting" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect((response as any).error.message).toContain("name");
    expect(mockReadResource).not.toHaveBeenCalled();
  });

  it("rejects an unknown resource as invalid_request", async () => {
    await renderLoaded();
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "nope" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(mockReadResource).not.toHaveBeenCalled();
  });

  it("maps a failed read to execution_failed", async () => {
    await renderLoaded();
    mockReadResource.mockRejectedValue(new Error("boom"));
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "Alpha" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
  });

  it("refuses when the server is disconnected (no read)", async () => {
    await renderLoaded({ status: "disconnected" });
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "Alpha" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect(mockReadResource).not.toHaveBeenCalled();
  });

  it("truncates a huge body and keeps the full body out of the snapshot", async () => {
    mockReadResource.mockResolvedValue({
      content: {
        contents: [{ type: "text", text: SECRET_BODY.repeat(2000) }],
      },
    });
    await renderLoaded();
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "Alpha" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "resource_read", truncated: true },
    });

    const snapshot = await readSurfaceSnapshot("resources");
    const serialized = JSON.stringify(snapshot);
    // The snapshot reports presence/size, never the body itself.
    expect(serialized).not.toContain(SECRET_BODY);
    expect((snapshot as any).data.lastResult.present).toBe(true);
    expect((snapshot as any).data.lastResult.approxSizeBytes).toBeGreaterThan(
      MAX_RESULT_CHARS,
    );
  });
});


/** The resolved server entry the step-up lifecycle needs. */
const stepUpServer = { name: "srv" } as unknown as ServerWithName;

describe("ResourcesTab — agent-driven step-up lifecycle (SEP-2350)", () => {
  // The defect these pin: the agent handler called the same API as the button
  // while skipping the step-up lifecycle entirely, so an agent-triggered
  // `403 insufficient_scope` could not start a re-authorization, and an
  // agent-triggered success left the bounded budget stale for a later,
  // legitimate step-up on another screen.
  beforeEach(() => {
    __resetScopeStepUpInFlightForTests();
  });

  it("drives the step-up when an agent-driven read hits a 403", async () => {
    mockReadResource.mockRejectedValueOnce(
      new McpRequestError("Forbidden", {
        status: 403,
        insufficientScope: { requiredScope: "files:write" },
      }),
    );
    await renderLoaded({ server: stepUpServer });
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "Alpha" },
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

  it("resets the budget when an agent-driven read succeeds", async () => {
    await renderLoaded({ server: stepUpServer });
    const response = await dispatch({
      type: "readResource",
      payload: { resource: "Alpha" },
    });
    expect(response).toMatchObject({ status: "success" });
    // A stale budget would otherwise suppress a later legitimate step-up.
    expect(mockResetToolCallStepUp).toHaveBeenCalledWith(stepUpServer);
  });

  it("leaves an ordinary failure alone", async () => {
    mockReadResource.mockRejectedValueOnce(new Error("network down"));
    await renderLoaded({ server: stepUpServer });
    await dispatch({
      type: "readResource",
      payload: { resource: "Alpha" },
    });
    expect(mockApplyToolCallStepUp).not.toHaveBeenCalled();
    expect(mockResetToolCallStepUp).not.toHaveBeenCalled();
  });
});

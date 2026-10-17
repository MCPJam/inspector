import { describe, expect, it, vi } from "vitest";
import spec from "../../../../docs/reference/openapi.json";
import { z } from "zod";
import { PlatformApiClient } from "../client.js";
import { authorizeLocalExecutionOperation } from "../operations.js";
import {
  localExecutionAuthorizationSchema,
  localExecutionTargetSchema,
} from "../local-execution.js";
const target = {
  kind: "local-native",
  scope: "unattended",
  harnessId: "codex",
  machineId: "machine",
  workspaceGrantId: "workspace",
  runtimeId: "runtime",
  permissionProfile: "unrestricted",
  policyVersion: "policy",
  grantToken: "a-valid-capability-token",
} as const;
describe("local execution authorization", () => {
  it.each(["claude-code", "codex"] as const)(
    "resolves the project for %s",
    async (harnessId) => {
      const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith("/projects"))
          return Response.json({
            items: [{ id: "project", name: "My project" }],
          });
        expect(String(url)).toMatch(
          /projects\/project\/local-execution-grants$/
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          harnessId,
          allowUnattended: true,
          workspaceGrantId: "workspace",
        });
        return Response.json({
          target: { ...target, harnessId },
          expiresAt: "2026-10-17T00:00:00Z",
        });
      });
      const client = new PlatformApiClient({
        getAuth: () => "jwt",
        baseUrl: "http://localhost:6274/api/v1",
        fetch: fetchMock,
      });
      const result = await authorizeLocalExecutionOperation.execute(
        {
          project: "My project",
          harnessId,
          allowUnattended: true,
          workspaceGrantId: "workspace",
        },
        { client }
      );
      expect(result.target).toEqual({ ...target, harnessId });
    }
  );
  it("requires explicit unattended consent before any request", async () => {
    const fetchMock = vi.fn();
    const client = new PlatformApiClient({
      getAuth: () => "jwt",
      fetch: fetchMock,
    });
    await expect(
      authorizeLocalExecutionOperation.execute(
        { harnessId: "codex", allowUnattended: false } as never,
        { client }
      )
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { scope: "attended" },
    { permissionProfile: "workspace-edits" },
    { grantToken: "" },
  ])("rejects invalid grants %j", (override) => {
    expect(
      localExecutionTargetSchema.safeParse({ ...target, ...override }).success
    ).toBe(false);
  });
});

it("documents the same authorization and target schemas as the SDK", () => {
  for (const [name, schema] of [
    ["LocalExecutionAuthorization", localExecutionAuthorizationSchema],
    ["LocalExecutionTarget", localExecutionTargetSchema],
  ] as const) {
    const { $schema: _dialect, ...contract } = z.toJSONSchema(schema);
    expect(spec.components.schemas[name]).toEqual(contract);
  }
});

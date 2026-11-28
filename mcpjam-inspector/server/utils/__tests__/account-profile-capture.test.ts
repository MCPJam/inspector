import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@mcpjam/sdk", () => ({ captureOpenAIProfile: mocks.capture }));

import {
  captureAccountProfile,
  captureHostedOnlyAccountProfiles,
  connectedAccounts,
  isHostedOnlyAccount,
} from "../account-profile-capture.js";
import {
  setManagerAuthorizedCredentials,
  setManagerConnections,
} from "../mcp-connections.js";

const target = { key: "tasks", serverId: "server-1", connectionId: "conn-1" };
const options = { bearer: "member-bearer", projectId: "project-1" };
const profile = { id: "user-7", name: "Automation" };

type Answer = Record<string, unknown> | { status: number };

/** Answers each backend operation in turn and records what was asked. */
function backend(answers: Record<string, Answer>) {
  const calls: Array<{ operation: string; body: Record<string, unknown> }> =
    [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const operation = url.split("/").pop()!;
    calls.push({ operation, body: JSON.parse(String(init.body)) });
    const answer = answers[operation] ?? {};
    if ("status" in answer && typeof answer.status === "number")
      return new Response("{}", { status: answer.status });
    return Response.json(answer);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const manager = {} as Pick<MCPClientManager, "listTools" | "executeTool">;

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  mocks.capture.mockReset();
  mocks.capture.mockResolvedValue({ profile, structuredContent: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("captureAccountProfile", () => {
  it("records a shared or uploaded account's identity against the token the backend named", async () => {
    const calls = backend({
      "capture-context": {
        connectionId: "conn-1",
        expectedVaultObjectId: "generation-1",
        hostedOnly: true,
      },
      profile: { outcome: "recorded" },
    });
    await captureAccountProfile(manager, target, {
      ...options,
      hostedOnly: true,
    });
    expect(mocks.capture).toHaveBeenCalledWith(manager, "tasks", {
      timeoutMs: expect.any(Number),
    });
    expect(calls).toEqual([
      {
        operation: "capture-context",
        body: {
          projectId: "project-1",
          serverId: "server-1",
          connectionId: "conn-1",
        },
      },
      {
        operation: "profile",
        body: {
          projectId: "project-1",
          serverId: "server-1",
          connectionId: "conn-1",
          profile,
          expectedVaultObjectId: "generation-1",
        },
      },
    ]);
  });

  it("asks nothing of the server for an account the caller cannot record, or an older backend refuses", async () => {
    for (const answer of [
      { outcome: "missing" },
      { status: 403 },
      // A person's own sign-in, captured when they signed in.
      { connectionId: "conn-1", expectedVaultObjectId: "generation-1" },
    ]) {
      const calls = backend({ "capture-context": answer });
      await captureAccountProfile(manager, target, {
        ...options,
        hostedOnly: true,
      });
      expect(calls.map((call) => call.operation)).toEqual(["capture-context"]);
    }
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("writes nothing when the identity is unchanged or the server has no profile tool", async () => {
    const calls = backend({
      "capture-context": {
        expectedVaultObjectId: "generation-1",
        hostedOnly: true,
        profile: { ...profile, capturedAt: 1 },
      },
    });
    await captureAccountProfile(manager, target, options);
    mocks.capture.mockResolvedValue({
      profile: undefined,
      reason: "No unique profile tool is designated",
    });
    await captureAccountProfile(manager, target, options);
    expect(calls.map((call) => call.operation)).toEqual([
      "capture-context",
      "capture-context",
    ]);
  });
});

describe("captureHostedOnlyAccountProfiles", () => {
  it("never rejects, so a failed capture leaves the connect as it was", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await expect(
      captureHostedOnlyAccountProfiles(manager, [target], options),
    ).resolves.toBeUndefined();
  });

  it("does nothing without a bearer or an account", async () => {
    const calls = backend({});
    await captureHostedOnlyAccountProfiles(manager, [target], {
      ...options,
      bearer: "",
    });
    await captureHostedOnlyAccountProfiles(manager, [], options);
    expect(calls).toEqual([]);
  });
});

describe("connectedAccounts", () => {
  it("lists a server's account group, else the credential its base key connected on", () => {
    const grouped = {
      listServers: () => ["srv", "srv::a"],
    } as unknown as MCPClientManager;
    setManagerConnections(grouped, {
      srv: [
        { serverId: "srv", connectionId: "a", key: "srv::a", label: "A" },
      ],
    });
    expect(connectedAccounts(grouped, "srv")).toEqual([
      { key: "srv::a", serverId: "srv", connectionId: "a" },
    ]);

    const single = { listServers: () => ["srv"] } as unknown as MCPClientManager;
    setManagerAuthorizedCredentials(single, { srv: "only" });
    expect(connectedAccounts(single, "srv")).toEqual([
      { key: "srv", serverId: "srv", connectionId: "only" },
    ]);
    expect(connectedAccounts(single, "other")).toEqual([]);
  });

  it("tells shared and uploaded accounts from a person's own sign-in", () => {
    expect(isHostedOnlyAccount({ accountKind: "shared" })).toBe(true);
    expect(isHostedOnlyAccount({ accountKind: "uploaded" })).toBe(true);
    expect(isHostedOnlyAccount({ accountUploaded: true })).toBe(true);
    expect(isHostedOnlyAccount({})).toBe(false);
    expect(isHostedOnlyAccount(undefined)).toBe(false);
  });
});

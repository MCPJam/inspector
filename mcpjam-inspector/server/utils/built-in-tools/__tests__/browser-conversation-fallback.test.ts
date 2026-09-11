import { describe, expect, it, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  ensureLive: vi.fn(),
  provision: vi.fn(),
  sandboxInfo: vi.fn(),
  wake: vi.fn(),
  resolveSession: vi.fn(),
}));

vi.mock("../../../services/browserd/live-session-deps.js", () => ({
  ensureLiveBrowserSession: hoisted.ensureLive,
}));

vi.mock("../../computers/control-plane-client.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../computers/control-plane-client.js")
  >();
  return {
    ...actual,
    provisionPlaygroundSandbox: hoisted.provision,
    getComputerSandboxInfo: hoisted.sandboxInfo,
    wakePlaygroundSandbox: hoisted.wake,
  };
});

vi.mock("../../../services/browserd/session-service.js", () => ({
  BrowserSessionService: class {
    enabled = true;
    resolveSession = hoisted.resolveSession;
    downloadProfile = vi.fn(async () => null);
    bindBox = vi.fn(async () => ({ sessionId: "bs_1" }));
    recordBoot = vi.fn(async () => true);
    touch = vi.fn(async () => true);
    setTabs = vi.fn(async () => true);
    close = vi.fn(async () => true);
  },
}));

import { buildBrowserTools, ensureHostedConversationSession } from "../browser";

/** A live daemon handle, shaped as the computer arm returns one. */
function computerHandle() {
  return {
    engine: "hosted" as const,
    target: "computer" as const,
    sessionId: "sess-1",
    computerId: "computer-1",
    bootId: "boot-1",
    contextMode: "persistent" as const,
    reused: false,
    streamUrl: "https://box.example/vnc.html",
    streamPassword: "pw",
    client: {
      sendCommand: vi.fn(async () => ({
        status: "ok",
        bootId: "boot-1",
        result: { ok: true, output: {} },
      })),
      status: vi.fn(async () => ({ bootId: "boot-1" })),
    },
  };
}

function buildHosted(sessionScope?: {
  kind: "conversation";
  sessionId: string;
  hostId?: string;
}) {
  return buildBrowserTools({
    authHeader: "Bearer user",
    projectId: "project-1",
    engine: "hosted",
    approvalDelivery: { kind: "attested" },
    ...(sessionScope ? { sessionScope } : {}),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.ensureLive.mockResolvedValue(computerHandle());
  hoisted.provision.mockResolvedValue({
    ok: true,
    value: { sandboxRowId: "row-1", providerSandboxId: "sbx-1" },
  });
  hoisted.resolveSession.mockResolvedValue({
    sessionId: "bs_1",
    owner: { kind: "conversation", id: "chat-a" },
    projectId: "project-1",
    ownerUserId: "user-1",
    engine: "hosted",
    profile: "blank",
    state: "active",
    createdAt: 1,
    lastActiveAt: 1,
    lastCommandAt: 1,
  });
});

describe("a conversation-scoped hosted turn with no host", () => {
  it("resolves the logical record before binding a hostless chat's own sandbox", async () => {
    const built = buildHosted({ kind: "conversation", sessionId: "chat-a" });
    await built!.tools.browser_observe.execute!({}, {
      toolCallId: "call-1",
    } as never);
    expect(hoisted.resolveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { kind: "conversation", id: "chat-a" },
      }),
    );
    expect(hoisted.ensureLive).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalSessionId: "bs_1",
        target: {
          kind: "sandbox",
          sandboxRowId: "row-1",
          sandboxId: "sbx-1",
          watched: true,
        },
      }),
    );
  });
  it("does not fall back when direct-chat admission refuses", async () => {
    hoisted.provision.mockResolvedValue({
      ok: false,
      status: 409,
      error: "browser_not_advertised",
    });
    const built = buildHosted({ kind: "conversation", sessionId: "chat-a" });
    await expect(
      built!.tools.browser_observe.execute!({}, {
        toolCallId: "call-1",
      } as never),
    ).rejects.toThrow("browser_not_advertised");
    expect(hoisted.ensureLive).not.toHaveBeenCalled();
  });
});

describe("a conversation-scoped hosted turn WITH a host", () => {
  it("provisions the conversation's own watched box", async () => {
    hoisted.provision.mockResolvedValue({
      ok: true,
      value: { sandboxRowId: "row-1", providerSandboxId: "sbx-1" },
    });
    hoisted.ensureLive.mockResolvedValue({
      ...computerHandle(),
      target: "sandbox" as const,
      sandboxRowId: "row-1",
      sandboxId: "sbx-1",
      watched: true,
    });

    const built = buildHosted({
      kind: "conversation",
      sessionId: "chat-a",
      hostId: "host-1",
    });
    await built!.tools.browser_observe.execute!({}, {
      toolCallId: "call-1",
    } as never);

    expect(hoisted.provision).toHaveBeenCalledTimes(1);
    // Keyed by the CONVERSATION, not by the logical row id: the scope key is
    // `playground:<chatSessionId>`, so a retry of the same conversation finds
    // the box it already booted.
    expect(hoisted.provision.mock.calls[0]?.[0]).toMatchObject({
      projectId: "project-1",
      chatSessionId: "chat-a",
      hostId: "host-1",
    });
  });
});

describe("an unscoped hosted turn", () => {
  it("is unchanged: the project computer, no durable identity", async () => {
    const built = buildHosted();
    await built!.tools.browser_observe.execute!({}, {
      toolCallId: "call-1",
    } as never);

    expect(hoisted.resolveSession).not.toHaveBeenCalled();
    expect(hoisted.provision).not.toHaveBeenCalled();
    expect(hoisted.ensureLive).toHaveBeenCalledTimes(1);
  });
});


describe("unattended recording targets", () => {
  it.each(["eval_iteration", "swarm_attempt"] as const)("preserves recording opt-in for %s", async ownerKind => {
    await ensureHostedConversationSession({ bearer: "Bearer user", projectId: "project-1", logicalSessionId: "run", ownerKind, contextMode: "ephemeral", target: { kind: "sandbox", sandboxRowId: "row", sandboxId: "box", record: true } });
    expect(hoisted.ensureLive).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ record: true }) }));
    expect(hoisted.provision).not.toHaveBeenCalled();
  });
});

/**
 * WHICH BOX a conversation-scoped hosted turn resolves.
 *
 * Per-conversation browsers used to sit behind a PostHog flag, so the default
 * everywhere was the member's one project computer. Deleting that flag makes
 * the conversation path the default for every hosted Playground turn — and the
 * backend re-derives "may this conversation have a desktop?" from the frozen
 * host config, refusing with `browser_not_advertised` when there is no host row
 * to read.
 *
 * A Playground turn may legitimately carry no `hostId` (an ad-hoc config sends
 * `builtInToolIds` on the body), and those turns have always browsed on the
 * project computer. Without the guard under test, removing the flag would turn
 * a browser that works today into a fail-closed error the first time somebody
 * called it. These tests are that guard: the session scope decides identity,
 * but a MISSING host falls back rather than refusing.
 *
 * `defaultEnsureSession` is the seam, so this file deliberately does NOT inject
 * `ensureSession` — the point is which of the two real doors it opens.
 */
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
  const actual =
    await importOriginal<
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

import { buildBrowserTools } from "../browser";

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
  it("uses the project computer instead of refusing", async () => {
    // The ad-hoc-config case. Before per-conversation browsers this turn
    // browsed on the project computer; it still must.
    const built = buildHosted({ kind: "conversation", sessionId: "chat-a" });
    await built!.tools.browser_observe.execute({}, {
      toolCallId: "call-1",
    } as never);

    expect(hoisted.provision).not.toHaveBeenCalled();
    expect(hoisted.ensureLive).toHaveBeenCalledTimes(1);
    // No sandbox target — this is the member's durable computer.
    expect(hoisted.ensureLive.mock.calls[0]?.[0]?.target).toBeUndefined();
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
    await built!.tools.browser_observe.execute({}, {
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
    await built!.tools.browser_observe.execute({}, {
      toolCallId: "call-1",
    } as never);

    expect(hoisted.resolveSession).not.toHaveBeenCalled();
    expect(hoisted.provision).not.toHaveBeenCalled();
    expect(hoisted.ensureLive).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  guestId: undefined as string | undefined,
  events: [] as string[],
  secrets: vi.fn(),
  acquire: vi.fn(),
  credentialRefusal: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../../browserd/page-tools-peek.js", async (original) => ({
  ...(await original<typeof import("../../browserd/page-tools-peek.js")>()),
  peekPageToolsForChatTurn: async () => undefined,
}));
vi.mock("../../../utils/built-in-tools/registry.js", () => ({
  resolveHostTools: () => ({}),
}));
vi.mock("../../../utils/harness/runtime-secrets.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/runtime-secrets.js")
  >()),
  fetchRuntimeSecrets: m.secrets,
}));
// The booking itself is stubbed one level down, so the turn's own early and
// late booking paths (`owned-playground-box.ts`) run as they do in production.
vi.mock("../../../utils/harness/playground-box.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/playground-box.js")
  >()),
  acquirePlaygroundHarnessBox: m.acquire,
  playgroundHarnessBoxUnavailableReason: () => null,
  playgroundCredentialRefusal: m.credentialRefusal,
}));
vi.mock(
  "../../../utils/computers/environment-context.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../utils/computers/environment-context.js")
    >()),
    maybeAppendEnvironmentContext: async (args: { systemPrompt?: string }) =>
      args.systemPrompt,
  }),
);
vi.mock("../../../routes/web/mcpjam-platform-client.js", () => ({
  buildMcpjamPlatformClient: () => undefined,
}));
import { prepareManagedTools } from "../managed-tools.js";
import { TurnResources } from "../resources.js";

type Setup = Parameters<typeof prepareManagedTools>[0]["setup"];
const harnessSetup = (harness: string) =>
  ({
    hostedBody: { projectId: "project-1", chatSessionId: "chat-1" },
    body: { chatSessionId: "chat-1" },
    turnMode: "interactive",
    pinsEnvironment: false,
    resolvedExecution: { harness },
    builtInToolPolicy: {},
    localBrowserSettingsUnavailable: false,
    turnBuiltInToolIds: [],
    systemPrompt: "system",
    requireToolApproval: true,
    scenarioParticipant: false,
  }) as Setup;

const box = {
  surface: "playground",
  binding: { sandboxRowId: "row", sandboxId: "sbx" },
  release: async () => {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function prepareTurn(harness: string) {
  const app = new Hono<{ Variables: { guestId?: string } }>();
  let failure: unknown;
  let sandboxId: string | undefined;
  app.post("/", async (c) => {
    if (m.guestId) c.set("guestId", m.guestId);
    try {
      const tools = await prepareManagedTools({
        c,
        rawBody: {},
        bearerToken: "bearer",
        localIngress: false,
        resources: new TurnResources(() => {}),
        setup: harnessSetup(harness),
        connections: { validatedPageTools: [] },
      });
      sandboxId = tools.scenarioBox?.binding.sandboxId;
    } catch (error) {
      failure = error;
    }
    return c.json({});
  });
  const done = app.request("/", { method: "POST" });
  return { done: done.then(() => ({ failure, sandboxId })) };
}

describe("the Playground box and the secrets read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.guestId = undefined;
    m.events = [];
  });

  it("books the conversation's box while the secrets read is in flight", async () => {
    const secrets = deferred<{ ok: true; secrets: [] }>();
    m.secrets.mockImplementation(() => {
      m.events.push("secrets:start");
      return secrets.promise;
    });
    m.acquire.mockImplementation(async () => {
      m.events.push("box:start");
      return { ok: true, box };
    });
    const turn = await prepareTurn("claude-code");
    await vi.waitFor(() => expect(m.events).toContain("box:start"));
    expect(m.events).toEqual(["box:start", "secrets:start"]);
    secrets.resolve({ ok: true, secrets: [] });
    expect(await turn.done).toEqual({ failure: undefined, sandboxId: "sbx" });
    expect(m.acquire).toHaveBeenCalledTimes(1);
  });

  it("books a box that checks the member's own credential only after the secrets read", async () => {
    const secrets = deferred<{ ok: true; secrets: [] }>();
    m.secrets.mockImplementation(() => {
      m.events.push("secrets:start");
      return secrets.promise;
    });
    m.acquire.mockImplementation(async () => {
      m.events.push("box:start");
      return { ok: true, box };
    });
    const turn = await prepareTurn("cursor");
    await vi.waitFor(() => expect(m.events).toContain("secrets:start"));
    expect(m.events).toEqual(["secrets:start"]);
    secrets.resolve({ ok: true, secrets: [] });
    await turn.done;
    expect(m.events).toEqual(["secrets:start", "box:start"]);
  });

  it("refuses with the box's own status and retry wait when the early booking is refused", async () => {
    m.secrets.mockResolvedValue({ ok: true, secrets: [] });
    m.acquire.mockResolvedValue({
      ok: false,
      refusal: { status: 429, error: "busy", retryAfterMs: 2500 },
    });
    const { failure } = await (await prepareTurn("codex")).done;
    expect(failure).toMatchObject({ status: 429 });
    expect((failure as { headers?: Record<string, string> }).headers).toEqual({
      "Retry-After": "3",
    });
  });

  it("books no box when the member's own credential is refused", async () => {
    m.secrets.mockResolvedValue({ ok: true, secrets: [] });
    m.credentialRefusal.mockResolvedValueOnce(
      "Add your CURSOR_API_KEY to this project to run Cursor.",
    );
    const { failure } = await (await prepareTurn("cursor")).done;
    expect(failure).toMatchObject({ status: 409 });
    expect(m.acquire).not.toHaveBeenCalled();
  });

  it("leaves a guest's turn without a Playground box", async () => {
    m.guestId = "guest-1";
    m.secrets.mockResolvedValue({ ok: true, secrets: [] });
    const { failure } = await (await prepareTurn("claude-code")).done;
    expect(failure).toBeUndefined();
    expect(m.acquire).not.toHaveBeenCalled();
  });
});

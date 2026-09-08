import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let home = "";
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home };
});

const {
  parseSessionPolicy,
  policyRefusalFor,
  originRefusalFor,
  resolveAgentActor,
  runAgentCommand,
} = await import("../agent-door");
const { openAgentSession, readLedger } = await import("../agent-session-store");
const { CommandLedger } = await import("../../daemon/command-ledger");
import type { BrowserCommand } from "../../protocol";
import type { BrowserdCommandResponse } from "../../browserd-codec";
import type { BrowserAgentSessionPolicy } from "../../../../../shared/browser-agent-contract";

const PROJECT = "proj-door";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "mcpjam-agent-door-"));
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(join(home, ".mcpjam"), { recursive: true, force: true });
});

/** A daemon that answers whatever the test wants, and records what it was sent. */
function fakeClient(response: BrowserdCommandResponse) {
  const sent: BrowserCommand[] = [];
  const refusals: Array<{ command: BrowserCommand; errorCode: string }> = [];
  const ledger = new CommandLedger({ bootId: "boot-1" });
  return {
    sent,
    refusals,
    ledger,
    client: {
      async sendCommand(command: BrowserCommand) {
        sent.push(command);
        // The real handler writes the row; this stands in for that so the
        // door's `ledger` link has something to find.
        ledger.record({
          command,
          actor: command.actor ?? { kind: "inspector", id: "unattributed" },
          ts: Date.now(),
          durationMs: 1,
          outcome: response.status === "ok" ? "executed" : "refused",
          ...(response.status === "ok" ? { ok: response.result.ok } : {}),
        });
        return response;
      },
      async recordRefusal(args: { command: BrowserCommand; errorCode: string }) {
        refusals.push(args);
        const row = ledger.record({
          command: args.command,
          actor: args.command.actor ?? { kind: "inspector", id: "unattributed" },
          ts: Date.now(),
          durationMs: 0,
          outcome: "refused" as const,
          errorCode: args.errorCode,
        });
        return { seq: row.seq };
      },
      async readTrace(args: { commandId?: string; limit?: number } = {}) {
        return ledger.read(args);
      },
    },
  };
}

async function session(policy: BrowserAgentSessionPolicy = { mode: "allow_all" }) {
  const opened = await openAgentSession({
    projectId: PROJECT,
    engine: "local",
    profile: "persistent",
    policy,
    createdBy: "user-1",
    actor: { actorId: "cli:abc", kind: "agent" },
    bootId: "boot-1",
  });
  if (!opened.ok) throw new Error("could not open a session");
  return opened.session;
}

const ACTOR = { kind: "agent", id: "cli:abc" } as const;

describe("resolveAgentActor", () => {
  it("fixes the kind by the route and never takes it from a body", () => {
    // Reaching this door means an agent. A body that could say otherwise could
    // claim to be the person whose lease the daemon does not block.
    const actor = resolveAgentActor({
      userId: "user-9",
      clientKind: "human",
      clientId: "abc",
    });
    expect(actor.kind).toBe("agent");
    // An unrecognized client kind falls back rather than being echoed.
    expect(actor.id).toBe("agent:abc");
    expect(actor.label).toBe("user-9");
  });

  it("sanitizes a declared client id into a single safe segment", () => {
    const actor = resolveAgentActor({
      userId: "u",
      clientKind: "cli",
      clientId: "../../evil id!",
    });
    expect(actor.id).toBe("cli:....evilid");
  });

  it("says `anonymous` rather than inventing an identity", () => {
    // A self-hosted inspector with no AuthKit has nobody to name, and the trace
    // should SHOW that rather than paper over it.
    expect(resolveAgentActor({ clientKind: "cli", clientId: "x" }).label).toBe(
      "anonymous",
    );
  });
});

describe("the session policy", () => {
  it("refuses a malformed policy instead of defaulting to something permissive", () => {
    expect(parseSessionPolicy(undefined)).toBeUndefined();
    expect(parseSessionPolicy({ mode: "yolo" })).toBeUndefined();
    // An `allowlist` with nothing in it would silently mean "everything".
    expect(parseSessionPolicy({ mode: "allowlist" })).toBeUndefined();
    expect(parseSessionPolicy({ mode: "read_only" })).toEqual({
      mode: "read_only",
    });
  });

  it("read_only frees observation and nothing else", () => {
    // A policy cannot make clicking a button on a live logged-in page safe.
    const policy = { mode: "read_only" } as const;
    expect(
      policyRefusalFor(policy, { op: "observe", mode: "a11y" }),
    ).toBeUndefined();
    for (const command of [
      { op: "act", verb: "click" },
      { op: "navigate", url: "https://x.test" },
      { op: "reload" },
      { op: "invoke_page_tool", toolKey: "pay", input: {} },
    ] as const) {
      expect(policyRefusalFor(policy, command)?.code).toBe("tool_not_allowed");
    }
  });

  it("enforces a toolAllowlist by op name", () => {
    const policy = {
      mode: "allowlist",
      toolAllowlist: ["observe", "navigate"],
    } as const;
    expect(policyRefusalFor(policy, { op: "navigate", url: "https://x.test" }))
      .toBeUndefined();
    expect(policyRefusalFor(policy, { op: "act", verb: "click" })?.code).toBe(
      "tool_not_allowed",
    );
  });

  it("checks the origin allowlist on the way in", () => {
    const policy = {
      mode: "allowlist",
      originAllowlist: ["https://ok.test"],
    } as const;
    expect(
      policyRefusalFor(policy, { op: "navigate", url: "https://ok.test/a" }),
    ).toBeUndefined();
    expect(
      policyRefusalFor(policy, { op: "navigate", url: "https://evil.test/a" })
        ?.code,
    ).toBe("origin_not_allowed");
  });

  it("fails CLOSED on a URL it cannot parse", () => {
    // An allowlist that fails open is not an allowlist.
    const policy = {
      mode: "allowlist",
      originAllowlist: ["https://ok.test"],
    } as const;
    expect(originRefusalFor(policy, "not a url")?.code).toBe(
      "origin_not_allowed",
    );
  });

  it("does nothing when no origin allowlist was declared", () => {
    expect(originRefusalFor({ mode: "allow_all" }, "https://any.test")).toBeUndefined();
  });
});

describe("runAgentCommand", () => {
  it("stamps source `agent` and the actor, never reading them from the caller", async () => {
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    await runAgentCommand({
      session: await session(),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "reload" },
    });
    expect(fake.sent[0]).toMatchObject({
      source: "agent",
      actor: { kind: "agent", id: "cli:abc" },
    });
  });

  it("returns an executed result carrying the page, fenced as untrusted", async () => {
    const fake = fakeClient({
      status: "ok",
      result: {
        ok: true,
        output: { url: "https://x.test/p", a11y: "button e1 Save" },
        stateToken: { tabId: "t1", navCounter: 1, urlHash: "a", domHash: "b" },
      },
      bootId: "boot-1",
    });
    const ran = await runAgentCommand({
      session: await session(),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "observe", mode: "a11y" },
    });
    expect(ran.status).toBe(200);
    expect(ran.result.status).toBe("executed");
    if (ran.result.status !== "executed") throw new Error("wrong arm");
    expect(ran.result.page?.pageContent).toMatchObject({
      untrusted: true,
      a11y: "button e1 Save",
    });
    expect(ran.result.page?.viewport).toEqual({ width: 1024, height: 768 });
    expect(ran.result.ledger?.seq).toBeGreaterThan(0);
  });

  it("refuses a policy-excluded command WITHOUT sending anything to the browser", async () => {
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const ran = await runAgentCommand({
      session: await session({ mode: "read_only" }),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "act", verb: "click" },
    });
    expect(ran.status).toBe(403);
    expect(ran.result.status).toBe("refused");
    expect(fake.sent).toHaveLength(0);
    // …and it is still RECORDED, through the daemon, so the one ordered ledger
    // stays one ordered ledger with one seq minter.
    expect(fake.refusals[0]?.errorCode).toBe("tool_not_allowed");
  });

  it("refuses a redirect that landed outside the origin allowlist", async () => {
    // A navigate to an allowed origin can redirect to one that is not; without
    // the result-URL check the observation of the excluded page comes back.
    const fake = fakeClient({
      status: "ok",
      result: { ok: true, output: { url: "https://evil.test/landed" } },
      bootId: "boot-1",
    });
    const ran = await runAgentCommand({
      session: await session({
        mode: "allowlist",
        originAllowlist: ["https://ok.test"],
      }),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "navigate", url: "https://ok.test/start" },
    });
    expect(ran.status).toBe(403);
    if (ran.result.status !== "refused") throw new Error("wrong arm");
    expect(ran.result.refusal.code).toBe("origin_not_allowed");
    // The page is NOT handed back with the refusal.
    expect(ran.result.refusal.page).toBeUndefined();
  });

  it("maps a lease block to a refusal with no page", async () => {
    const fake = fakeClient({
      status: "lease_blocked",
      lease: "held",
      holder: "alice",
      bootId: "boot-1",
    });
    const ran = await runAgentCommand({
      session: await session(),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "observe", mode: "screenshot" },
    });
    expect(ran.status).toBe(423);
    if (ran.result.status !== "refused") throw new Error("wrong arm");
    expect(ran.result.refusal.code).toBe("lease_held");
    expect(ran.result.refusal.page).toBeUndefined();
  });

  it("maps a stale observation to a refusal that CARRIES the fresh page", async () => {
    const fake = fakeClient({
      status: "stale_observation",
      result: { ok: true, output: { url: "https://x.test/moved" } },
      bootId: "boot-1",
    });
    const ran = await runAgentCommand({
      session: await session(),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "act", verb: "click", target: { ref: "e1" } },
    });
    expect(ran.status).toBe(409);
    if (ran.result.status !== "refused") throw new Error("wrong arm");
    expect(ran.result.refusal.code).toBe("stale_observation");
    // So the caller re-decides in one round trip instead of being told to look
    // again.
    expect(ran.result.refusal.page?.pageContent.url).toBe("https://x.test/moved");
  });

  it("maps an evicted result and an unknown boot to UNKNOWN, never refused", async () => {
    for (const [status, reason] of [
      ["expired", "expired"],
      ["unknown_boot", "unknown_boot"],
    ] as const) {
      const fake = fakeClient({ status, bootId: "boot-1" });
      const ran = await runAgentCommand({
        session: await session(),
        client: fake.client,
        ledger: fake.ledger,
        bootId: "boot-1",
        actor: ACTOR,
        command: { op: "reload" },
      });
      expect(ran.result.status).toBe("unknown");
      if (ran.result.status !== "unknown") throw new Error("wrong arm");
      expect(ran.result.unknown.reason).toBe(reason);
      // Telling a caller "refused" here is how a payment gets submitted twice.
      expect(ran.result.unknown.instruction).toContain("Do NOT");
    }
  });

  it("answers UNKNOWN when the transport itself failed", async () => {
    const ran = await runAgentCommand({
      session: await session(),
      client: {
        sendCommand: async () => {
          throw new Error("socket closed");
        },
        recordRefusal: async () => ({ seq: 0 }),
        readTrace: async () => ({ entries: [], headSeq: 0 }),
      },
      ledger: new CommandLedger({ bootId: "boot-1" }),
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "reload" },
    });
    expect(ran.status).toBe(502);
    expect(ran.result.status).toBe("unknown");
  });

  it("refuses an out-of-viewport coordinate before the browser sees it", async () => {
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const ran = await runAgentCommand({
      session: await session(),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "act", verb: "click", target: { coordinates: [5000, 5] } },
    });
    expect(ran.status).toBe(400);
    expect(fake.sent).toHaveLength(0);
  });

  it("mirrors the ring so the trace already has the command it just answered", async () => {
    // A caller that read the trace immediately and did not find its own command
    // would reasonably conclude it had not run.
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const opened = await session();
    const ran = await runAgentCommand({
      session: opened,
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "reload" },
      commandId: "cmd-1",
    });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: opened.sessionId,
    });
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]).toMatchObject({
      commandId: "cmd-1",
      actor: { id: "cli:abc" },
    });
    expect(ran.session.lastSeq).toBe(1);
  });

  it("warns on the command itself when the history could not be written", async () => {
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const ran = await runAgentCommand({
      // A session whose project key was never validated into a real directory
      // stands in for a sink that cannot be written.
      session: { ...(await session()), projectId: " bad" },
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "reload" },
    });
    // Never silent: the caller is told the trace has a hole rather than
    // discovering it later where it was looking.
    expect(ran.result.historyWarning).toContain("could not be written");
  });
});

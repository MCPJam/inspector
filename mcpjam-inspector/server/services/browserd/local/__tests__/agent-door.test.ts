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
const { appendNote, openAgentSession, readLedger } = await import(
  "../agent-session-store"
);
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
        // door's `ledger` link has something to find. It must pass `output`
        // and `capturePage` exactly as the handler does, or the ledger mints
        // no artifact ids and the fake quietly tests a different system.
        const executed = response.status === "ok";
        ledger.record({
          command,
          actor: command.actor ?? { kind: "inspector", id: "unattributed" },
          ts: Date.now(),
          durationMs: 1,
          outcome: executed ? "executed" : "refused",
          ...(executed ? { ok: response.result.ok } : {}),
          ...(executed
            ? { output: response.result.output, capturePage: true }
            : {}),
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
      command: { op: "act", verb: "click", target: { selector: "#save" } },
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

  it("records a refused command as what it WAS, not as a placeholder", async () => {
    // The regression this pins: a refusal recorded as a generic action turns
    // "the agent tried to type into the password field and was refused" into a
    // row that says something else, which is worse than no row at all because
    // it looks like history.
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    await runAgentCommand({
      session: await session({ mode: "read_only" }),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: {
        op: "act",
        verb: "type",
        target: { selector: "#password" },
        value: "hunter2",
      },
    });
    const recorded = fake.refusals[0]?.command;
    expect(recorded?.action).toMatchObject({
      kind: "act",
      verb: "type",
      target: { selector: "#password" },
    });
    // …and the ledger still redacts the value on the way in.
    const row = fake.ledger.read({ limit: 1 }).entries[0];
    expect(row.kind === "command" && row.command).toMatchObject({
      verb: "type",
      redactedValue: { redacted: true, chars: 7 },
    });
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("records an out-of-viewport act with the coordinates that were refused", async () => {
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    await runAgentCommand({
      session: await session(),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "act", verb: "click", target: { coordinates: [5000, 5] } },
    });
    const row = fake.ledger.read({ limit: 1 }).entries[0];
    expect(row.kind === "command" && row.command).toMatchObject({
      verb: "click",
      target: { coordinates: [5000, 5] },
    });
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

  it("hands back the screenshot's artifact id, or the picture is unreachable", async () => {
    // The ids are minted when the ledger lifts the payload out of the row, so
    // they exist nowhere in the daemon's own result. Without them a caller is
    // told a screenshot was taken and given no way to fetch it — which for
    // `observe {mode:"screenshot"}` means the command returns no picture.
    const fake = fakeClient({
      status: "ok",
      result: { ok: true, output: { screenshot: "AAAA", url: "https://x.test" } },
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
    if (ran.result.status !== "executed") throw new Error("wrong arm");
    expect(ran.result.page?.artifacts?.screenshot?.id).toBeTruthy();
    expect(ran.result.page?.artifacts?.screenshot?.mediaType).toBe("image/jpeg");
    // Still not inline: the row points at the payload, it does not carry it.
    expect(JSON.stringify(ran.result)).not.toContain("AAAA");
  });

  it("links to the DURABLE seq, not the daemon ring's", async () => {
    // The two number rows differently — the store's seq spans boots and counts
    // notes — so handing back the ring's would give a caller a cursor in a
    // coordinate space `mcpjam browser trace --after-seq` does not use.
    const opened = await session();
    const withNote = await appendNote({
      session: opened,
      text: "before",
      actor: ACTOR,
      bootId: "boot-1",
    });
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const ran = await runAgentCommand({
      session: withNote,
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "reload" },
      commandId: "cmd-after-note",
    });
    // The note took durable seq 1, so this command is 2 — while the daemon's
    // own ring, which never saw the note, calls it 1.
    expect(ran.result.ledger?.seq).toBe(2);
    const found = await readLedger({
      projectId: PROJECT,
      sessionId: opened.sessionId,
      commandId: "cmd-after-note",
    });
    expect(found.entries[0]?.seq).toBe(2);
  });

  it("reports an off-allowlist RESULT url as executed-and-failed, never refused", async () => {
    // The command already ran — the page it landed on is the problem. `refused`
    // promises nothing ran and that a retry is safe, which is how the same form
    // gets submitted twice.
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
    // A 403 still, because the caller's policy is what stopped this — but the
    // OUTCOME in the body says the command ran.
    expect(ran.status).toBe(403);
    expect(ran.result.status).toBe("executed");
    if (ran.result.status !== "executed") throw new Error("wrong arm");
    expect(ran.result.ok).toBe(false);
    expect(ran.result.error?.code).toBe("origin_not_allowed");
    // The page is still withheld — that is what the check is for.
    expect(ran.result.page).toBeUndefined();
    expect(JSON.stringify(ran.result)).not.toContain("evil.test/landed");
  });

  it("withholds an off-allowlist page from a stale-observation refusal too", async () => {
    // A redirect can land the tab outside the allowlist; a refusal carrying
    // that observation would hand over exactly what the success path withholds.
    const fake = fakeClient({
      status: "stale_observation",
      result: { ok: true, output: { url: "https://evil.test/moved" } },
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
      command: { op: "act", verb: "click", target: { selector: "#save" } },
    });
    if (ran.result.status !== "refused") throw new Error("wrong arm");
    expect(ran.result.refusal.code).toBe("stale_observation");
    expect(ran.result.refusal.page).toBeUndefined();
    expect(JSON.stringify(ran.result)).not.toContain("evil.test");
  });

  it("refuses a ref target as caller-fixable, not as a policy denial", async () => {
    // 400 and `unsupported_target`: the caller can fix this by using a
    // selector. Reporting it as `tool_not_allowed` would tell an agent to give
    // up on a capability the session actually has.
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const ran = await runAgentCommand({
      session: await session(),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "act", verb: "click", target: { ref: "e7" } },
    });
    expect(ran.status).toBe(400);
    if (ran.result.status !== "refused") throw new Error("wrong arm");
    expect(ran.result.refusal.code).toBe("unsupported_target");
    expect(fake.sent).toHaveLength(0);
    // Recorded as the act it was, with the ref it named.
    expect(fake.refusals[0]?.command.action).toMatchObject({
      kind: "act",
      target: { a11yRef: "e7" },
    });
  });

  it("does not duplicate history when two mirrors race", async () => {
    // `mirrorLedger` is a read-modify-write over one file. Two commands on
    // different tabs, or a command racing the rail's trace poll, would both
    // read the same cursor, both append the same slice, and advance it once.
    // A duplicated click is worse than a gap: a gap says so.
    const opened = await session();
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    await Promise.all([
      runAgentCommand({
        session: opened,
        client: fake.client,
        ledger: fake.ledger,
        bootId: "boot-1",
        actor: ACTOR,
        command: { op: "act", verb: "click", target: { selector: "#a" } },
        commandId: "cmd-a",
        tabId: "tab-1",
      }),
      runAgentCommand({
        session: opened,
        client: fake.client,
        ledger: fake.ledger,
        bootId: "boot-1",
        actor: ACTOR,
        command: { op: "act", verb: "click", target: { selector: "#b" } },
        commandId: "cmd-b",
        tabId: "tab-2",
      }),
    ]);
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: opened.sessionId,
      limit: 100,
    });
    const ids = trace.entries
      .filter((e) => e.kind === "command")
      .map((e) => (e.kind === "command" ? e.commandId : ""));
    expect(ids.sort()).toEqual(["cmd-a", "cmd-b"]);
    // And each row still has its own position.
    expect(new Set(trace.entries.map((e) => e.seq)).size).toBe(
      trace.entries.length,
    );
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

  it("warns when a REFUSAL could not be recorded either", async () => {
    // The hardest hole to notice. A refusal the ring never took leaves nothing
    // for the mirror to copy, so the caller gets a perfectly complete-looking
    // `refused` answer about a command its trace will never mention.
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const ran = await runAgentCommand({
      session: await session({ mode: "read_only" }),
      client: {
        ...fake.client,
        async recordRefusal() {
          throw new Error("ring unavailable");
        },
      },
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      // Refused by the policy, so nothing reaches the browser.
      command: { op: "act", verb: "click", target: { coordinates: [10, 10] } },
    });
    expect(ran.result.status).toBe("refused");
    expect(ran.result.historyWarning).toContain("could not be written");
    expect(ran.result.historyWarning).toContain("ring unavailable");
    expect(ran.result).not.toHaveProperty("ledger");
  });

  it("says nothing about history when the refusal WAS recorded", async () => {
    const fake = fakeClient({ status: "ok", result: { ok: true }, bootId: "boot-1" });
    const ran = await runAgentCommand({
      session: await session({ mode: "read_only" }),
      client: fake.client,
      ledger: fake.ledger,
      bootId: "boot-1",
      actor: ACTOR,
      command: { op: "act", verb: "click", target: { coordinates: [10, 10] } },
    });
    expect(ran.result.status).toBe("refused");
    expect(ran.result.historyWarning).toBeUndefined();
    expect(ran.result).toHaveProperty("ledger");
  });
});

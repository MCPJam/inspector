import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A home directory per test run.
 *
 * The store derives every path from `getLocalBrowserRoot()`, which is under the
 * user's real `~/.mcpjam`. A suite that wrote sessions and screenshots there
 * would be scribbling in a developer's actual browser history.
 */
let home = "";
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home };
});

const {
  appendNote,
  findOpenSession,
  leaveAgentSession,
  listAgentSessions,
  mirrorLedger,
  openAgentSession,
  readArtifact,
  readLedger,
  readSession,
  validateSessionId,
} = await import("../agent-session-store");
const { CommandLedger } = await import("../../daemon/command-ledger");
import type { BrowserCommand } from "../../protocol";
import type { BrowserLedgerActor } from "../../daemon/command-ledger";

const PROJECT = "proj-alpha";
const AGENT: BrowserLedgerActor = { kind: "agent", id: "cli:abc" };
const POLICY = { mode: "allow_all" } as const;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "mcpjam-agent-sessions-"));
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  // A fresh tree per test: sessions are discovered by listing a directory, so
  // one test's leftovers would be another's "live session to attach to".
  await rm(join(home, ".mcpjam"), { recursive: true, force: true });
});

function open(over: Partial<Parameters<typeof openAgentSession>[0]> = {}) {
  return openAgentSession({
    projectId: PROJECT,
    engine: "local",
    profile: "persistent",
    policy: POLICY,
    createdBy: "user-1",
    actor: { actorId: AGENT.id, kind: AGENT.kind },
    bootId: "boot-1",
    ...over,
  });
}

function cmd(commandId: string, over: Partial<BrowserCommand> = {}): BrowserCommand {
  return {
    commandId,
    source: "agent",
    action: { kind: "reload" },
    actor: AGENT,
    ...over,
  };
}

function ledgerWith(bootId: string, rows: Array<{ id: string; output?: unknown }>) {
  let n = 0;
  const ledger = new CommandLedger({ bootId, mintId: () => `art-${++n}` });
  for (const row of rows) {
    ledger.record({
      command: cmd(row.id),
      actor: AGENT,
      ts: 1,
      durationMs: 1,
      outcome: "executed",
      ok: true,
      ...(row.output ? { output: row.output, capturePage: true } : {}),
    });
  }
  return ledger;
}

describe("the logical session", () => {
  it("outlives a boot: the id is stable and the boots are recorded on it", async () => {
    // The hosted boot row is replaced whenever the bundle or the box changes,
    // so a permalink and an agent's history cannot hang off it. This can.
    const first = await open();
    expect(first.ok && first.session.sessionId).toMatch(/^bs_/);
    const rejoined = await open({ bootId: "boot-2" });
    expect(rejoined.ok && rejoined.session.sessionId).toBe(
      first.ok ? first.session.sessionId : "",
    );
    expect(rejoined.ok && rejoined.session.boots.map((b) => b.bootId)).toEqual([
      "boot-1",
      "boot-2",
    ]);
  });

  it("ATTACHES by default, so an agent and a person share one browser", async () => {
    const created = await open();
    const joined = await open({
      actor: { actorId: "mcp:claude", kind: "agent" },
    });
    expect(joined.ok && joined.attached).toBe(true);
    expect(joined.ok && joined.session.participants.map((p) => p.actorId)).toEqual([
      "cli:abc",
      "mcp:claude",
    ]);
    expect(joined.ok && joined.session.sessionId).toBe(
      created.ok ? created.session.sessionId : "",
    );
  });

  it("does not add the same participant twice", async () => {
    await open();
    const again = await open();
    expect(again.ok && again.session.participants).toHaveLength(1);
  });

  it("creates a separate session on attach: never", async () => {
    const a = await open();
    const b = await open({ attach: "never" });
    expect(a.ok && b.ok && a.session.sessionId).not.toBe(
      b.ok ? b.session.sessionId : "",
    );
    expect(b.ok && b.attached).toBe(false);
  });

  it("refuses attach: require when there is nothing to join", async () => {
    const result = await open({ attach: "require" });
    expect(result).toEqual({ ok: false, reason: "nothing_to_attach" });
  });

  it("never attaches to an EPHEMERAL session", async () => {
    // The point of having no profile is that one run cannot inherit another's
    // cookies; joining one would hand that straight back.
    const first = await open({ profile: "ephemeral" });
    const second = await open({ profile: "ephemeral" });
    expect(second.ok && second.attached).toBe(false);
    expect(first.ok && second.ok && first.session.sessionId).not.toBe(
      second.ok ? second.session.sessionId : "",
    );
  });

  it("DETACHES on close, leaving the browser for the other participants", async () => {
    const created = await open();
    await open({ actor: { actorId: "pane:user-1", kind: "human" } });
    const sessionId = created.ok ? created.session.sessionId : "";
    const left = await leaveAgentSession({
      projectId: PROJECT,
      sessionId,
      actorId: "cli:abc",
    });
    expect(left?.participants.map((p) => p.actorId)).toEqual(["pane:user-1"]);
    // Still open: an agent finishing must not close the window a person is
    // still watching.
    expect(left?.closedAt).toBeUndefined();
    expect(await findOpenSession(PROJECT)).toBeDefined();
  });

  it("closes the session only on an explicit terminate", async () => {
    const created = await open();
    const sessionId = created.ok ? created.session.sessionId : "";
    const closed = await leaveAgentSession({
      projectId: PROJECT,
      sessionId,
      actorId: "cli:abc",
      terminate: true,
    });
    expect(closed?.closedAt).toBeGreaterThan(0);
    expect(await findOpenSession(PROJECT)).toBeUndefined();
  });

  it("rejects a session id it did not mint", () => {
    // The id becomes a path segment, so this is the boundary that keeps a
    // caller from naming a directory of its choosing.
    expect(() => validateSessionId("../../etc")).toThrow();
    expect(() => validateSessionId("bs_nope")).toThrow();
  });

  it("lists what it wrote", async () => {
    await open();
    await open({ attach: "never" });
    expect(await listAgentSessions(PROJECT)).toHaveLength(2);
  });
});

describe("the durable ledger sink", () => {
  it("mirrors the ring, re-keying onto a seq that survives a relaunch", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [{ id: "c1" }, { id: "c2" }]);
    const first = await mirrorLedger({ session, ledger, bootId: "boot-1" });
    expect(first.written).toBe(2);
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    expect(trace.entries.map((e) => e.seq)).toEqual([1, 2]);
    // The daemon's own seq is kept, so a row can still be found in its ring.
    expect(trace.entries.map((e) => e.bootSeq)).toEqual([1, 2]);
  });

  it("does not duplicate rows it has already mirrored", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [{ id: "c1" }]);
    const once = await mirrorLedger({ session, ledger, bootId: "boot-1" });
    const twice = await mirrorLedger({
      session: once.session,
      ledger,
      bootId: "boot-1",
    });
    expect(twice.written).toBe(0);
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    expect(trace.entries).toHaveLength(1);
  });

  it("writes a daemon_restart gap so a relaunch is visible, not a quiet stretch", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const first = await mirrorLedger({
      session,
      ledger: ledgerWith("boot-1", [{ id: "c1" }]),
      bootId: "boot-1",
    });
    await mirrorLedger({
      session: first.session,
      // A NEW ring, which cannot know it replaced another — so whoever notices
      // the bootId change writes the gap.
      ledger: ledgerWith("boot-2", [{ id: "c2" }]),
      bootId: "boot-2",
    });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    expect(trace.entries.map((e) => e.kind)).toEqual([
      "command",
      "gap",
      "command",
    ]);
    expect(trace.entries[1]).toMatchObject({ reason: "daemon_restart" });
    // The durable seq keeps climbing across the boot boundary.
    expect(trace.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("drains an artifact payload to a file and releases it from the daemon", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [
      { id: "c1", output: { screenshot: Buffer.from("PIXELS").toString("base64") } },
    ]);
    await mirrorLedger({ session, ledger, bootId: "boot-1" });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    const row = trace.entries[0];
    const artifactId =
      row.kind === "command" ? row.artifacts?.screenshot?.id : undefined;
    expect(artifactId).toBeDefined();
    const bytes = await readArtifact({
      projectId: PROJECT,
      sessionId: session.sessionId,
      artifactId: artifactId!,
      mediaType: "image/jpeg",
    });
    expect(bytes?.toString()).toBe("PIXELS");
    // The daemon's store is a hand-off buffer, not a second copy: holding
    // megabytes of pictures that already exist as files is how a long session
    // runs a laptop out of memory.
    expect(ledger.artifact(artifactId!)).toBeUndefined();
  });

  it("honours captureScreenshots: false without losing the row", async () => {
    const created = await open({ captureScreenshots: false });
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [
      { id: "c1", output: { screenshot: "AAAA" } },
    ]);
    await mirrorLedger({
      session,
      ledger,
      bootId: "boot-1",
      captureScreenshots: false,
    });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    const row = trace.entries[0];
    // The row still says a screenshot was taken; the picture was not kept.
    expect(row.kind === "command" && row.artifacts?.screenshot?.evicted).toBe(true);
    expect(
      await readArtifact({
        projectId: PROJECT,
        sessionId: session.sessionId,
        artifactId:
          row.kind === "command" ? row.artifacts!.screenshot!.id : "",
        mediaType: "image/jpeg",
      }),
    ).toBeUndefined();
  });

  it("reads forward from a cursor and by commandId", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    await mirrorLedger({
      session,
      ledger: ledgerWith("boot-1", [{ id: "c1" }, { id: "c2" }, { id: "c3" }]),
      bootId: "boot-1",
    });
    const tail = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
      afterSeq: 2,
    });
    expect(tail.entries.map((e) => e.seq)).toEqual([3]);
    expect(tail.headSeq).toBe(3);
    const found = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
      commandId: "c2",
    });
    expect(found.entries).toHaveLength(1);
  });

  it("skips one unreadable line rather than losing the whole history", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    await mirrorLedger({
      session,
      ledger: ledgerWith("boot-1", [{ id: "c1" }]),
      bootId: "boot-1",
    });
    const file = join(
      home,
      ".mcpjam",
      "computer",
      "browser",
      PROJECT,
      "sessions",
      session.sessionId,
      "ledger.jsonl",
    );
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, "{ this is not json\n");
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    expect(trace.entries).toHaveLength(1);
  });

  it("records a note as its own row, not disguised as an observation", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const after = await appendNote({
      session,
      text: "about to sign in",
      actor: AGENT,
      bootId: "boot-1",
    });
    expect(after.lastSeq).toBe(1);
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    expect(trace.entries[0]).toMatchObject({
      kind: "command",
      command: { kind: "note", value: "about to sign in" },
    });
  });

  it("writes its files private to the user", async () => {
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const stored = await readSession(PROJECT, session.sessionId);
    expect(stored?.sessionId).toBe(session.sessionId);
    const { stat } = await import("node:fs/promises");
    const file = join(
      home,
      ".mcpjam",
      "computer",
      "browser",
      PROJECT,
      "sessions",
      session.sessionId,
      "session.json",
    );
    // These files hold a browsing history and the screenshots that go with it.
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).policy).toEqual(POLICY);
  });
});

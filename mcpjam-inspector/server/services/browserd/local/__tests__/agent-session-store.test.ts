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
  disposeBrowserIfUnshared,
  artifactMediaType,
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

function ledgerWith(
  bootId: string,
  rows: Array<{ id: string; output?: unknown }>,
  options: { maxRows?: number } = {},
) {
  let n = 0;
  const ledger = new CommandLedger({
    bootId,
    mintId: () => `art-${++n}`,
    ...(options.maxRows ? { maxRows: options.maxRows } : {}),
  });
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

  it("refuses to attach under a DIFFERENT policy", async () => {
    // Attaching means sharing one browser under one policy. Taking the
    // caller's would widen what the running participants agreed to; ignoring it
    // would tell a caller its `read_only` was accepted while it drives a
    // session that can click anything.
    await open({ policy: { mode: "allow_all" } });
    const mismatched = await open({ policy: { mode: "read_only" } });
    expect(mismatched.ok).toBe(false);
    expect(!mismatched.ok && mismatched.reason).toBe("policy_mismatch");
    // …and the caller is told what IS running, so it can match or opt out.
    expect(
      !mismatched.ok && mismatched.reason === "policy_mismatch"
        ? mismatched.session.policy
        : null,
    ).toEqual({ mode: "allow_all" });
  });

  it("attaches when the policies agree, whatever the key order", async () => {
    await open({
      policy: {
        mode: "allowlist",
        originAllowlist: ["https://a.test", "https://b.test"],
      },
    });
    const joined = await open({
      policy: {
        mode: "allowlist",
        originAllowlist: ["https://b.test", "https://a.test"],
      },
      actor: { actorId: "mcp:other", kind: "agent" },
    });
    expect(joined.ok && joined.attached).toBe(true);
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

  it("keeps one session's rows out of another's history", async () => {
    // Two logical sessions can share one project browser; copying the whole
    // ring into whichever is being read would file each one's commands under
    // the other. A row nobody claimed (a model- or pane-driven command on the
    // shared browser) genuinely belongs in both.
    const a = await open();
    const b = await open({ attach: "never" });
    if (!a.ok || !b.ok) throw new Error("no sessions");
    const ledger = new CommandLedger({ bootId: "boot-1" });
    for (const [id, sessionId] of [
      ["mine", a.session.sessionId],
      ["theirs", b.session.sessionId],
      ["shared", undefined],
    ] as const) {
      ledger.record({
        command: cmd(id),
        actor: AGENT,
        ...(sessionId ? { sessionId } : {}),
        ts: 1,
        durationMs: 1,
        outcome: "executed",
        ok: true,
      });
    }
    await mirrorLedger({ session: a.session, ledger, bootId: "boot-1" });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: a.session.sessionId,
    });
    expect(
      trace.entries
        .filter((e) => e.kind === "command")
        .map((e) => (e.kind === "command" ? e.commandId : "")),
    ).toEqual(["mine", "shared"]);
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
    });
    expect(bytes?.toString()).toBe("PIXELS");
    // The daemon's store is a hand-off buffer, not a second copy: holding
    // megabytes of pictures that already exist as files is how a long session
    // runs a laptop out of memory.
    expect(ledger.artifact(artifactId!)).toBeUndefined();
  });

  it("keeps a SHARED command's artifact readable from both sessions", async () => {
    // Two logical sessions can share one browser, and a command nobody claimed
    // is mirrored into both histories. The payload lives in the daemon once, so
    // the first mirror used to write it into its own directory and release it —
    // and the second recorded the very same screenshot as `evicted`, with no
    // way to fetch a picture that was sitting on disk.
    const a = await open();
    const b = await open({ attach: "never" });
    if (!a.ok || !b.ok) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [
      { id: "c1", output: { screenshot: Buffer.from("SHARED").toString("base64") } },
    ]);
    await mirrorLedger({ session: a.session, ledger, bootId: "boot-1" });
    await mirrorLedger({ session: b.session, ledger, bootId: "boot-1" });
    for (const sessionId of [a.session.sessionId, b.session.sessionId]) {
      const trace = await readLedger({ projectId: PROJECT, sessionId });
      const row = trace.entries[0];
      const ref = row.kind === "command" ? row.artifacts?.screenshot : undefined;
      expect(ref?.evicted).toBeUndefined();
      const bytes = await readArtifact({
        projectId: PROJECT,
        sessionId,
        artifactId: ref!.id,
      });
      expect(bytes?.toString()).toBe("SHARED");
    }
  });

  it("holds the open lock across the dispose, so no session slips in", async () => {
    // The close route used to mark the session closed, list the others, then
    // dispose — three awaits with nothing holding them together, so an `open`
    // whose session appeared in the gap was invisible to the check and had its
    // browser shut underneath it. This asserts the MUTUAL EXCLUSION, not just
    // the count: while the dispose runs, an open for the project cannot finish.
    const created = await open();
    if (!created.ok) throw new Error("no session");

    let releaseDispose: () => void = () => {};
    const disposeStarted = new Promise<void>((startedResolve) => {
      const blocked = new Promise<void>((r) => (releaseDispose = r));
      void disposeBrowserIfUnshared({
        projectId: PROJECT,
        sessionId: created.session.sessionId,
        session: created.session,
        dispose: async () => {
          startedResolve();
          await blocked;
          return "disposed" as const;
        },
      });
    });
    await disposeStarted;

    let opened = false;
    const opening = open({ attach: "never" }).then((r) => {
      opened = true;
      return r;
    });
    // A tick or two: without the lock the open would have completed by now.
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toBe(false);

    releaseDispose();
    await opening;
    expect(opened).toBe(true);
  });

  it("a mirror cannot resurrect a session that was terminated", async () => {
    // Both are read-modify-writes over one file. Without a shared lock they
    // interleave: the mirror reads an OPEN record, terminate writes `closedAt`,
    // and the mirror writes its own copy back — un-closing a session somebody
    // had just ended, and letting its history keep growing afterwards.
    const created = await open();
    if (!created.ok) throw new Error("no session");
    const closed = await leaveAgentSession({
      projectId: PROJECT,
      sessionId: created.session.sessionId,
      actorId: AGENT.id,
      terminate: true,
    });
    expect(closed?.closedAt).toBeDefined();

    // The caller's snapshot is the PRE-close record, which is exactly what a
    // trace read holds when a terminate lands while it is queueing.
    const { session, written } = await mirrorLedger({
      session: created.session,
      ledger: ledgerWith("boot-1", [{ id: "c1" }]),
      bootId: "boot-1",
    });
    expect(written).toBe(0);
    expect(session.closedAt).toBeDefined();

    // On disk too: nothing was appended and the record is still closed.
    const after = await readSession(PROJECT, created.session.sessionId);
    expect(after?.closedAt).toBeDefined();
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: created.session.sessionId,
    });
    expect(trace.entries).toHaveLength(0);
  });

  it("survives two sessions writing one shared artifact at once", async () => {
    // The store is the PROJECT's; the mirror serializes per SESSION. Two
    // sessions copying the same unclaimed row hold different locks and can
    // both reach the write for one id.
    //
    // This asserts the OUTCOME — both sessions end up able to read the whole
    // payload, and no staging file is orphaned. It does NOT prove the write is
    // atomic: catching a torn read means reading between a truncate and a
    // write, which cannot be provoked deterministically from here. The `rename`
    // in `drainArtifact` is what closes that window, and this test would not
    // fail if it were removed.
    const a = await open();
    const b = await open({ attach: "never" });
    if (!a.ok || !b.ok) throw new Error("no session");
    const big = Buffer.alloc(256 * 1024, 7).toString("base64");
    const ledgerA = ledgerWith("boot-1", [
      { id: "c1", output: { screenshot: big } },
    ]);
    const ledgerB = ledgerWith("boot-1", [
      { id: "c1", output: { screenshot: big } },
    ]);
    // Both mirrors in flight at once, as two sessions genuinely are.
    await Promise.all([
      mirrorLedger({ session: a.session, ledger: ledgerA, bootId: "boot-1" }),
      mirrorLedger({ session: b.session, ledger: ledgerB, bootId: "boot-1" }),
    ]);
    for (const sessionId of [a.session.sessionId, b.session.sessionId]) {
      const trace = await readLedger({ projectId: PROJECT, sessionId });
      const ref =
        trace.entries[0].kind === "command"
          ? trace.entries[0].artifacts?.screenshot
          : undefined;
      const bytes = await readArtifact({
        projectId: PROJECT,
        sessionId,
        artifactId: ref!.id,
      });
      // Whole, not a prefix.
      expect(bytes?.byteLength).toBe(Buffer.from(big, "base64").byteLength);
    }
    // And no staging files left behind.
    const { readdir } = await import("node:fs/promises");
    const dir = join(home, ".mcpjam", "computer", "browser", PROJECT, "artifacts");
    expect((await readdir(dir)).some((n) => n.endsWith(".part"))).toBe(false);
  });

  it("marks EVICTED only when the payload really is gone", async () => {
    // A row whose picture aged out of the ring before anything mirrored it is
    // the genuine loss this flag exists to report, and it must keep reporting
    // it — "there was a screenshot and it is gone" is a more useful statement
    // than a dangling id.
    const created = await open();
    if (!created.ok) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [
      { id: "c1", output: { screenshot: "AAAA" } },
    ]);
    const id = ledger.read({ limit: 1 }).entries[0];
    const artifactId =
      id.kind === "command" ? id.artifacts!.screenshot!.id : "";
    ledger.releaseArtifact(artifactId);
    await mirrorLedger({ session: created.session, ledger, bootId: "boot-1" });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: created.session.sessionId,
    });
    const row = trace.entries[0];
    expect(row.kind === "command" && row.artifacts?.screenshot?.evicted).toBe(
      true,
    );
  });

  it("one session's captureScreenshots: false does not empty another's", async () => {
    // The setting is about THIS session's history. Dropping the daemon's only
    // copy on a peer's behalf is the same lost-screenshot bug wearing a
    // preference as a disguise — and the quieter one, because the session that
    // asked for no pictures gets exactly what it asked for.
    const quiet = await open({ captureScreenshots: false });
    const watching = await open({ attach: "never" });
    if (!quiet.ok || !watching.ok) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [
      { id: "c1", output: { screenshot: Buffer.from("KEPT").toString("base64") } },
    ]);
    await mirrorLedger({
      session: quiet.session,
      ledger,
      bootId: "boot-1",
      captureScreenshots: false,
    });
    await mirrorLedger({
      session: watching.session,
      ledger,
      bootId: "boot-1",
    });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: watching.session.sessionId,
    });
    const ref =
      trace.entries[0].kind === "command"
        ? trace.entries[0].artifacts?.screenshot
        : undefined;
    expect(ref?.evicted).toBeUndefined();
    expect(
      (
        await readArtifact({
          projectId: PROJECT,
          sessionId: watching.session.sessionId,
          artifactId: ref!.id,
        })
      )?.toString(),
    ).toBe("KEPT");
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
      }),
    ).toBeUndefined();
  });

  it("resolves the media type of an artifact past the trace's page size", async () => {
    // `readLedger` is the PAGED reader a cursor walks, capped at 1000 rows.
    // Looking a media type up through it answered "no such artifact" for every
    // artifact after the thousandth, and the route served a perfectly good
    // screenshot as an octet-stream. A lookup by id is not a page.
    const created = await open();
    if (!created.ok) throw new Error("no session");
    // Cheap filler rows, then the one that matters — past where a page ends.
    const rows: Array<{ id: string; output?: unknown }> = Array.from(
      { length: 1100 },
      (_, n) => ({ id: `c${n}` }),
    );
    rows.push({
      id: "late",
      output: { screenshot: Buffer.from("X").toString("base64") },
    });
    const ledger = ledgerWith("boot-1", rows, { maxRows: 2000 });
    // One mirror copies at most a thousand rows, so this takes two.
    const first = await mirrorLedger({
      session: created.session,
      ledger,
      bootId: "boot-1",
    });
    const { session } = await mirrorLedger({
      session: first.session,
      ledger,
      bootId: "boot-1",
    });
    const { entries, headSeq } = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
      afterSeq: 1100,
    });
    expect(headSeq).toBeGreaterThan(1000);
    const ref = entries.find(
      (e) => e.kind === "command" && e.artifacts?.screenshot,
    );
    const id =
      ref?.kind === "command" ? ref.artifacts!.screenshot!.id : undefined;
    expect(id).toBeDefined();
    // The paged reader genuinely cannot see it, which is why this exists.
    expect(
      (
        await readLedger({
          projectId: PROJECT,
          sessionId: session.sessionId,
          limit: 1000,
        })
      ).entries.some((e) => e.kind === "command" && e.artifacts?.screenshot),
    ).toBe(false);
    expect(
      await artifactMediaType({
        projectId: PROJECT,
        sessionId: session.sessionId,
        artifactId: id!,
      }),
    ).toBe("image/jpeg");
  });

  it("finds a TEXT artifact without being told its media type", async () => {
    // The filename used to carry an extension derived from the media type, so a
    // reader had to already know what an artifact was in order to find it: a
    // fetch without one looked for `<id>.jpg` and 410'd on a file sitting right
    // there as `<id>.txt`. The row carries the type; the name only has to be
    // unique.
    const created = await open();
    const session = created.ok ? created.session : null;
    if (!session) throw new Error("no session");
    const ledger = ledgerWith("boot-1", [
      { id: "c1", output: { text: "readable page text" } },
    ]);
    await mirrorLedger({ session, ledger, bootId: "boot-1" });
    const trace = await readLedger({
      projectId: PROJECT,
      sessionId: session.sessionId,
    });
    const row = trace.entries[0];
    const ref = row.kind === "command" ? row.artifacts?.text : undefined;
    expect(ref?.mediaType).toBe("text/plain");
    const bytes = await readArtifact({
      projectId: PROJECT,
      sessionId: session.sessionId,
      artifactId: ref!.id,
    });
    expect(bytes?.toString()).toBe("readable page text");
    // …and the row is what says how to interpret those bytes.
    expect(
      await artifactMediaType({
        projectId: PROJECT,
        sessionId: session.sessionId,
        artifactId: ref!.id,
      }),
    ).toBe("text/plain");
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

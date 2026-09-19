import { describe, expect, it } from "vitest";
import {
  CommandLedger,
  redactAction,
  sanitizeLedgerUrl,
  type BrowserLedgerActor,
  type CommandLedgerOptions,
} from "../command-ledger";
import type { BrowserAction, BrowserCommand } from "../../protocol";

const AGENT: BrowserLedgerActor = { kind: "agent", id: "cli:abc" };

function cmd(
  commandId: string,
  action: BrowserAction,
  overrides: Partial<BrowserCommand> = {},
): BrowserCommand {
  return { commandId, source: "agent", action, ...overrides };
}

function ledger(options: Partial<CommandLedgerOptions> = {}) {
  let n = 0;
  return new CommandLedger({
    bootId: "boot-a",
    mintId: () => `art-${++n}`,
    ...options,
  });
}

describe("sanitizeLedgerUrl", () => {
  it("strips the query and the fragment", () => {
    // Where the secrets are: a magic-link token, a password-reset id, and the
    // search somebody typed all ride in exactly these two places.
    expect(sanitizeLedgerUrl("https://x.test/a?token=hunter2#section")).toBe(
      "https://x.test/a",
    );
  });

  it("strips HTTP userinfo — the password IS in the URL", () => {
    // Stripping only the query and fragment would leave the one credential
    // this policy exists to keep out of a shareable history.
    expect(sanitizeLedgerUrl("https://alice:hunter2@x.test/p?q=1")).toBe(
      "https://x.test/p",
    );
    expect(sanitizeLedgerUrl("https://alice@x.test/p")).toBe("https://x.test/p");
  });

  it("omits a data: URL entirely", () => {
    // A data: URL IS the page content rather than a name for it, so keeping it
    // would put the page in the row under the guise of a location.
    expect(sanitizeLedgerUrl("data:text/html,<h1>hi</h1>")).toBeUndefined();
  });

  it("omits anything it cannot parse rather than keeping it unexamined", () => {
    expect(sanitizeLedgerUrl("not a url")).toBeUndefined();
    expect(sanitizeLedgerUrl("")).toBeUndefined();
    expect(sanitizeLedgerUrl(undefined)).toBeUndefined();
  });
});

describe("redactAction — the capture policy", () => {
  it("records a typed value's SHAPE, never its content", () => {
    const record = redactAction({
      kind: "act",
      verb: "type",
      target: { selector: "#password" },
      value: "hunter2-and-more",
    });
    expect(record.value).toBeUndefined();
    expect(record.redactedValue).toEqual({ redacted: true, chars: 16 });
    // The character count is the diagnostic half and is deliberately kept:
    // "they typed 16 characters here" is usually the whole question.
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("keeps press keys, select options and scroll amounts — they are not secrets", () => {
    expect(redactAction({ kind: "act", verb: "press", value: "Enter" }).value).toBe(
      "Enter",
    );
    expect(
      redactAction({
        kind: "act",
        verb: "select",
        target: { selector: "#country" },
        value: "GB",
      }).value,
    ).toBe("GB");
  });

  it("records a typed value verbatim only under the explicit per-session opt-in", () => {
    const record = redactAction(
      { kind: "act", verb: "type", value: "search term" },
      { captureTypedText: true },
    );
    expect(record.value).toBe("search term");
    expect(record.redactedValue).toBeUndefined();
  });

  it("strips a navigate URL and never records a page tool's input", () => {
    expect(
      redactAction({ kind: "navigate", url: "https://x.test/p?session=abc" }).url,
    ).toBe("https://x.test/p");
    const invoke = redactAction({
      kind: "webmcp_invoke",
      toolKey: "pay",
      input: { apiKey: "sk-live-secret" },
    });
    expect(invoke.toolKey).toBe("pay");
    expect(JSON.stringify(invoke)).not.toContain("sk-live");
  });

  it("keeps the target for every target shape", () => {
    expect(
      redactAction({ kind: "act", verb: "click", target: { a11yRef: "e7" } }).target,
    ).toEqual({ a11yRef: "e7" });
    expect(
      redactAction({
        kind: "act",
        verb: "click",
        target: { coordinates: [12, 34] },
      }).target,
    ).toEqual({ coordinates: [12, 34] });
  });
});

describe("CommandLedger", () => {
  it("mints one monotonic seq per row and reads forward from a cursor", () => {
    const l = ledger();
    for (const id of ["a", "b", "c"]) {
      l.record({
        command: cmd(id, { kind: "observe", mode: "url" }),
        actor: AGENT,
        ts: 1,
        durationMs: 1,
        outcome: "executed",
        ok: true,
      });
    }
    expect(l.headSeq).toBe(3);
    const tail = l.read({ afterSeq: 1 });
    expect(tail.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(tail.headSeq).toBe(3);
  });

  it("finds a row by commandId — the lookup after an `unknown` outcome", () => {
    const l = ledger();
    l.record({
      command: cmd("c1", { kind: "reload" }),
      actor: AGENT,
      ts: 1,
      durationMs: 2,
      outcome: "unknown",
      errorCode: "command_unknown_boot",
    });
    const found = l.read({ commandId: "c1" });
    expect(found.entries).toHaveLength(1);
    expect(found.entries[0]).toMatchObject({
      commandId: "c1",
      outcome: "unknown",
      errorCode: "command_unknown_boot",
    });
  });

  it("attributes a row to the actor it was handed, and carries correlation", () => {
    const l = ledger();
    const row = l.record({
      command: cmd("c1", { kind: "reload" }),
      actor: { kind: "agent", id: "mcp:claude-code", label: "Claude Code" },
      sessionId: "sess-1",
      correlation: { chatSessionId: "chat-9", toolCallId: "call-3" },
      ts: 5,
      durationMs: 7,
      outcome: "executed",
      ok: true,
    });
    expect(row.actor).toEqual({
      kind: "agent",
      id: "mcp:claude-code",
      label: "Claude Code",
    });
    expect(row.sessionId).toBe("sess-1");
    expect(row.correlation).toEqual({
      chatSessionId: "chat-9",
      toolCallId: "call-3",
    });
    expect(row.source).toBe("agent");
  });

  it("drops an empty correlation rather than writing an empty object", () => {
    const l = ledger();
    const row = l.record({
      command: cmd("c1", { kind: "reload" }),
      actor: AGENT,
      correlation: {},
      ts: 1,
      durationMs: 1,
      outcome: "executed",
      ok: true,
    });
    expect(row).not.toHaveProperty("correlation");
  });

  it("captures NO artifacts for a row that was not permitted to look at the page", () => {
    // The lease refusal path. A ledger that stored a screenshot from a command
    // the lease refused would defeat the gate that refused it.
    const l = ledger();
    const row = l.record({
      command: cmd("c1", { kind: "observe", mode: "screenshot" }),
      actor: AGENT,
      ts: 1,
      durationMs: 1,
      outcome: "refused",
      errorCode: "lease_held",
      output: { screenshot: "BASE64PIXELS", url: "https://bank.test/login" },
      capturePage: false,
    });
    expect(row.artifacts).toBeUndefined();
    expect(row.url).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("BASE64PIXELS");
  });

  it("lifts a screenshot out of the row and into the artifact store", () => {
    const l = ledger();
    const row = l.record({
      command: cmd("c1", { kind: "observe", mode: "screenshot" }),
      actor: AGENT,
      ts: 1,
      durationMs: 1,
      outcome: "executed",
      ok: true,
      output: { screenshot: "AAAA", url: "https://x.test/p?q=1" },
      capturePage: true,
    });
    // The row keeps a descriptor, not a hundred kilobytes of picture.
    expect(row.artifacts?.screenshot).toMatchObject({
      id: "art-1",
      mediaType: "image/jpeg",
    });
    expect(JSON.stringify(row)).not.toContain("AAAA");
    expect(row.url).toBe("https://x.test/p");
    expect(l.artifact("art-1")).toMatchObject({
      data: "AAAA",
      encoding: "base64",
    });
  });

  it("releases an artifact once something durable has it, idempotently", () => {
    const l = ledger();
    l.record({
      command: cmd("c1", { kind: "observe", mode: "a11y" }),
      actor: AGENT,
      ts: 1,
      durationMs: 1,
      outcome: "executed",
      ok: true,
      output: { a11y: "button e1 Save" },
      capturePage: true,
    });
    expect(l.artifact("art-1")).toBeDefined();
    l.releaseArtifact("art-1");
    expect(l.artifact("art-1")).toBeUndefined();
    // Releasing twice, or releasing an id that already aged out, is a success:
    // the postcondition the caller wants is true either way.
    expect(() => l.releaseArtifact("art-1")).not.toThrow();
    expect(() => l.releaseArtifact("never-existed")).not.toThrow();
  });

  it("marks an artifact evicted on the row rather than silently forgetting it", () => {
    const l = ledger({ maxArtifacts: 1 });
    const first = l.record({
      command: cmd("c1", { kind: "observe", mode: "screenshot" }),
      actor: AGENT,
      ts: 1,
      durationMs: 1,
      outcome: "executed",
      ok: true,
      output: { screenshot: "AAAA" },
      capturePage: true,
    });
    l.record({
      command: cmd("c2", { kind: "observe", mode: "screenshot" }),
      actor: AGENT,
      ts: 2,
      durationMs: 1,
      outcome: "executed",
      ok: true,
      output: { screenshot: "BBBB" },
      capturePage: true,
    });
    // The row still SAYS a screenshot was taken — "there was one and it is
    // gone" is a different and more useful statement than a row that never
    // mentioned it.
    expect(first.artifacts?.screenshot?.evicted).toBe(true);
    expect(l.artifact(first.artifacts!.screenshot!.id)).toBeUndefined();
  });

  it("records an over-budget artifact as evicted instead of flushing the store for it", () => {
    const l = ledger({ maxArtifactBytes: 8 });
    const row = l.record({
      command: cmd("c1", { kind: "observe", mode: "text" }),
      actor: AGENT,
      ts: 1,
      durationMs: 1,
      outcome: "executed",
      ok: true,
      output: { text: "x".repeat(64) },
      capturePage: true,
    });
    expect(row.artifacts?.text?.evicted).toBe(true);
    expect(l.artifact(row.artifacts!.text!.id)).toBeUndefined();
  });

  it("writes a gap row when the ring overflows, in the timeline where the history is missing", () => {
    const l = ledger({ maxRows: 3 });
    for (const id of ["a", "b", "c", "d"]) {
      l.record({
        command: cmd(id, { kind: "reload" }),
        actor: AGENT,
        ts: 1,
        durationMs: 1,
        outcome: "executed",
        ok: true,
      });
    }
    const { entries } = l.read();
    const gaps = entries.filter((e) => e.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "gap", reason: "ring_overflow" });
    // A ring that quietly dropped its oldest rows would be indistinguishable
    // from a session where nothing happened.
    expect(entries.some((e) => e.kind === "command" && e.commandId === "a")).toBe(
      false,
    );
  });

  it("stays bounded across many overflows by coalescing into ONE leading gap", () => {
    // The failure this guards is a ring that fills up with gap rows about gap
    // rows: the gap is inserted after the drop loop rather than inside it, and
    // a leading overflow gap is extended rather than duplicated.
    const l = ledger({ maxRows: 4 });
    for (let i = 1; i <= 200; i++) {
      l.record({
        command: cmd(`c${i}`, { kind: "reload" }),
        actor: AGENT,
        ts: i,
        durationMs: 1,
        outcome: "executed",
        ok: true,
      });
    }
    const { entries } = l.read({ limit: 1000 });
    const gaps = entries.filter((e) => e.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(entries.length).toBeLessThanOrEqual(5); // maxRows + the one gap
    // The single gap describes EVERYTHING dropped so far, not just the last.
    expect(gaps[0]).toMatchObject({ fromSeq: 1, reason: "ring_overflow" });
    expect(entries[0]).toBe(gaps[0]); // and it sits where the history is missing
  });

  it("notes a daemon restart as a gap — a relaunch is visible, not a quiet stretch", () => {
    const l = ledger();
    l.noteGap("daemon_restart", { fromSeq: 1, toSeq: 40 });
    const { entries } = l.read();
    expect(entries[0]).toMatchObject({
      kind: "gap",
      reason: "daemon_restart",
      fromSeq: 1,
      toSeq: 40,
    });
  });

  it("records the console and error cursors, never the console text", () => {
    const l = ledger();
    const row = l.record({
      command: cmd("c1", { kind: "observe", mode: "console" }),
      actor: AGENT,
      ts: 1,
      durationMs: 1,
      outcome: "executed",
      ok: true,
      output: { console: [{ type: "error", text: "secret log line" }] },
      cursors: { console: 42, errors: 3 },
      capturePage: true,
    });
    expect(row.consoleSeqAfter).toBe(42);
    expect(row.errorsSeqAfter).toBe(3);
    // Cursors, not deltas: the row brackets the window rather than copying the
    // page's log into every row.
    expect(JSON.stringify(row)).not.toContain("secret log line");
  });

  it("caps a read and refuses a nonsensical limit", () => {
    const l = ledger({ maxRows: 600 });
    for (let i = 0; i < 300; i++) {
      l.record({
        command: cmd(`c${i}`, { kind: "reload" }),
        actor: AGENT,
        ts: 1,
        durationMs: 1,
        outcome: "executed",
        ok: true,
      });
    }
    expect(l.read({ limit: 10 }).entries).toHaveLength(10);
    expect(l.read({ limit: 0 }).entries).toHaveLength(1);
    expect(l.read({ limit: 99_999 }).entries).toHaveLength(300);
  });

  it("rejects a ring that could never hold a row", () => {
    expect(() => new CommandLedger({ bootId: "b", maxRows: 0 })).toThrow(RangeError);
  });
});

/**
 * A login, as a person reading the trace afterwards sees it.
 *
 * The rows are what "share this session" shares, so each case here is a
 * statement about what somebody else may learn: the NAME of a secret, yes; its
 * length, no; its value, never.
 */
describe("redactAction — a typed credential", () => {
  it("records the placeholder verbatim instead of a length", () => {
    // `{redacted: true, chars: 13}` here would be a true statement about
    // `{{secret:PW}}` and a false one about anything that matters.
    expect(
      redactAction({
        kind: "act",
        verb: "type",
        value: "{{secret:GITHUB_PASSWORD}}",
      }),
    ).toMatchObject({ placeholderValue: "{{secret:GITHUB_PASSWORD}}" });
  });

  it("keeps the placeholder out of `value` and `redactedValue`", () => {
    const record = redactAction({
      kind: "act",
      verb: "type",
      value: "{{secret:PW}}",
    });
    expect(record.value).toBeUndefined();
    expect(record.redactedValue).toBeUndefined();
  });

  it("still redacts an ordinary typed value", () => {
    expect(
      redactAction({ kind: "act", verb: "type", value: "hunter2" }),
    ).toMatchObject({ redactedValue: { redacted: true, chars: 7 } });
  });

  it("records a placeholder EMBEDDED in a longer value, whole", () => {
    // The surrounding text is the model's own and is not a credential; hiding
    // it would make the row less legible for no gain.
    expect(
      redactAction({
        kind: "act",
        verb: "type",
        value: "user-{{secret:SUFFIX}}@x.test",
      }),
    ).toMatchObject({ placeholderValue: "user-{{secret:SUFFIX}}@x.test" });
  });

  it("records fill_form field by field, under the same policy", () => {
    // The one command that fills a whole login form used to record the verb
    // and nothing else.
    expect(
      redactAction({
        kind: "act",
        verb: "fill_form",
        fields: [
          { selector: "#user", value: "alex" },
          { selector: "#pw", value: "{{secret:PW}}" },
        ],
      }).fields,
    ).toEqual([
      { selector: "#user", redactedValue: { redacted: true, chars: 4 } },
      { selector: "#pw", placeholderValue: "{{secret:PW}}" },
    ]);
  });

  it("records whether the form was SUBMITTED", () => {
    // "typed a credential" and "typed a credential and submitted" are
    // different events, and the row could not tell them apart.
    expect(
      redactAction({ kind: "act", verb: "type", value: "x", submit: true })
        .submit,
    ).toBe(true);
    expect(
      redactAction({ kind: "act", verb: "type", value: "x" }).submit,
    ).toBeUndefined();
  });

  it("captureTypedText does not change what a placeholder records", () => {
    // There is nothing withheld to opt back into: the value was never here.
    expect(
      redactAction(
        { kind: "act", verb: "type", value: "{{secret:PW}}" },
        { captureTypedText: true },
      ),
    ).toMatchObject({ placeholderValue: "{{secret:PW}}" });
  });
});

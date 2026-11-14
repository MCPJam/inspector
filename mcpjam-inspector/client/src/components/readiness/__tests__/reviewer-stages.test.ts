/**
 * The reviewer path's rows in words: each stage of the sign-in from the run
 * that worked on the attempt last, who the identity check found, and the
 * handover when the rehearsal stopped for a person.
 */
import { describe, expect, it } from "vitest";
import {
  frameOf,
  handoverOf,
  identityRow,
  reviewerPathRows,
  stageStatus,
  type PathRow,
} from "../reviewer-stages";
import {
  ACTION,
  ASKED,
  attemptIn,
  CONNECTED,
  CONSENTED,
  identityResults,
  NOV_13,
  OPENED,
  PASSED,
  REFUSED,
  REFUSED_DETAIL,
  SIGNED_IN,
  stage,
  VERIFIED,
  WAITING,
  WRONG_TENANT,
} from "./reviewer-fixtures";

const words = (rows: PathRow[]) =>
  rows.map(({ label, status, detail }) => [label, status, detail]);

describe("stageStatus", () => {
  it("says each stage status in the path's words", () => {
    expect(stageStatus("passed", false)).toBe("established");
    expect(stageStatus("failed", false)).toBe("failed");
    expect(stageStatus("skipped", false)).toBe("skipped");
    expect(stageStatus("blocked", false)).toBe("blocked");
  });

  it("calls the stage a rehearsal stopped at for a person a person's to finish", () => {
    expect(stageStatus("blocked", true)).toBe("waiting");
    // Only a blocked stage waits: what passed or failed stays as it was.
    expect(stageStatus("passed", true)).toBe("established");
    expect(stageStatus("failed", true)).toBe("failed");
  });
});

describe("reviewerPathRows", () => {
  it("before any rehearsal: the sign-in and the identity, none tested, and no verification", () => {
    const path = reviewerPathRows(null, []);
    expect(words(path.rows)).toEqual([
      ["Sign-in page", "not-tested", "Not tested yet."],
      ["Fresh sign-in", "not-tested", "Not tested yet."],
      ["Consent screen", "not-tested", "Not tested yet."],
      ["Reviewer connection", "not-tested", "Not tested yet."],
      ["Identity and tenant", "not-tested", "Not tested yet."],
    ]);
    expect(path.credentials).toBeUndefined();
    expect(path.recordingId).toBeUndefined();
  });

  it("a full rehearsal: every stage established, with its frame of the recording", () => {
    const path = reviewerPathRows(PASSED, VERIFIED);
    expect(words(path.rows)).toEqual([
      ["Sign-in page", "established", OPENED.detail],
      ["Fresh sign-in", "established", SIGNED_IN.detail],
      ["Consent screen", "established", CONSENTED.detail],
      ["Reviewer connection", "established", CONNECTED.detail],
      [
        "Identity and tenant",
        "established",
        "get_me answers as review@example.com in Review Org.",
      ],
    ]);
    expect(path.rows.map((row) => row.frame)).toEqual([
      { recordingId: "res_1", seconds: 2.1 },
      { recordingId: "res_1", seconds: 9.4 },
      { recordingId: "res_1", seconds: 14.8 },
      undefined,
      undefined,
    ]);
    expect(path).toMatchObject({ runId: "run_1", recordingId: "res_1" });
  });

  it("drops the consent screen once the reviewer connected without one", () => {
    const path = reviewerPathRows(
      attemptIn("passed", { stages: [OPENED, SIGNED_IN, CONNECTED] }),
      [],
    );
    expect(path.rows.map((row) => row.label)).toEqual([
      "Sign-in page",
      "Fresh sign-in",
      "Reviewer connection",
      "Identity and tenant",
    ]);
  });

  it("a verification stop: the step that asked waits for a person, and what follows waits on it", () => {
    const path = reviewerPathRows(WAITING, []);
    const waits = "Waits for the sign-in.";
    expect(words(path.rows)).toEqual([
      ["Sign-in page", "established", OPENED.detail],
      ["Fresh sign-in", "established", SIGNED_IN.detail],
      ["Verification", "waiting", ASKED],
      ["Consent screen", "blocked", waits],
      ["Reviewer connection", "blocked", waits],
      ["Identity and tenant", "blocked", waits],
    ]);
    expect(path.rows[2].frame).toEqual({ recordingId: "res_1", seconds: 11.2 });
  });

  it("a refused password fails the sign-in, and what follows was never tested", () => {
    const path = reviewerPathRows(REFUSED, []);
    const stopped = "The last rehearsal stopped before this stage.";
    expect(words(path.rows)).toEqual([
      ["Sign-in page", "established", OPENED.detail],
      ["Fresh sign-in", "failed", REFUSED_DETAIL],
      ["Consent screen", "not-tested", stopped],
      ["Reviewer connection", "not-tested", stopped],
      ["Identity and tenant", "not-tested", "Not tested yet."],
    ]);
  });

  it("labels a stage read off another provider's page as approximated, without the prefix", () => {
    const consent = stage(
      "consent",
      "passed",
      'Approximated: MCPJam approved access on the consent page ("Authorize").',
      12,
    );
    const [, , row] = reviewerPathRows(
      attemptIn("passed", { stages: [OPENED, SIGNED_IN, consent, CONNECTED] }),
      [],
    ).rows;
    expect(row).toMatchObject({
      label: "Consent screen",
      approximated: true,
      detail: 'MCPJam approved access on the consent page ("Authorize").',
    });
    expect(reviewerPathRows(PASSED, []).rows[2].approximated).toBe(false);
  });

  it("shows the run working now, and nothing of a resumed attempt's old run before its new one joins", () => {
    const old = [OPENED, stage("verification", "blocked", ASKED, 11.2)];
    const resumed = attemptIn("running", {
      stages: old,
      runIds: ["run_1"],
      currentRunId: undefined,
    });
    expect(reviewerPathRows(resumed, []).rows.map((row) => row.status)).toEqual(
      ["not-tested", "not-tested", "not-tested", "not-tested", "not-tested"],
    );
    expect(reviewerPathRows(resumed, []).rows[0].detail).toBe(
      "Not reached yet.",
    );

    const joined = attemptIn("running", {
      stages: [
        ...old,
        stage("connect-link", "passed", "Opened again.", 1, "run_2"),
      ],
      runIds: ["run_1", "run_2"],
      currentRunId: "run_2",
    });
    const path = reviewerPathRows(joined, []);
    expect(path.runId).toBe("run_2");
    expect(words(path.rows).slice(0, 2)).toEqual([
      ["Sign-in page", "established", "Opened again."],
      ["Fresh sign-in", "not-tested", "Not reached yet."],
    ]);
  });

  it("gives row 1 the credentials stage, when the run could not read them", () => {
    const unavailable =
      "MCPJam could not read the reviewer's saved credentials for this run, so it did not sign in.";
    const path = reviewerPathRows(
      attemptIn("failed", {
        stages: [stage("credentials", "blocked", unavailable)],
      }),
      [],
    );
    expect(path.credentials).toMatchObject({
      label: "Reviewer credentials",
      status: "blocked",
      detail: unavailable,
    });
  });
});

describe("identityRow", () => {
  it("a verified reviewer: who the identity tool answers as, and where", () => {
    expect(identityRow(VERIFIED, null)).toMatchObject({
      status: "established",
      detail: "get_me answers as review@example.com in Review Org.",
    });
  });

  it("another organization reads as the wrong tenant, with what to do", () => {
    expect(identityRow(WRONG_TENANT, null)).toEqual({
      key: "identity",
      label: "Identity and tenant",
      status: "wrong-tenant",
      detail:
        "The reviewer account answers for organization Other Org, not Review Org. Leave the reviewer account in that one organization or project, then run again.",
    });
  });

  it("another account reads as the wrong account", () => {
    const row = identityRow(
      identityResults({
        outcome: "wrong-account",
        call: { tool: "get_me", arguments: {} },
        observed: { identity: "staff@example.com" },
        expected: { identity: "review@example.com" },
      }),
      null,
    );
    expect(row.status).toBe("wrong-account");
    expect(row.detail).toMatch(
      /^The reviewer account is signed in as staff@example.com, not review@example.com\./,
    );
  });

  it("no identity tool reads as unverified, with the reason and the next step", () => {
    const row = identityRow(
      identityResults({
        outcome: "unverified",
        reason: "the submission names no expected identity or organization",
      }),
      null,
    );
    expect(row).toMatchObject({
      status: "unverified",
      detail:
        "MCPJam could not check who the reviewer is: the submission names no expected identity or organization. Review the answers under Reviewer check, then run checks again.",
    });
  });

  it("says why a check that never reached the reviewer is blocked", () => {
    const placed = identityResults({ outcome: "verified" });
    const finding = placed
      .flatMap((step) => step.findings)
      .find((entry) => entry.finding.id === "both.reviewer.identity");
    if (!finding) throw new Error("No identity check placed");
    finding.finding = {
      ...finding.finding,
      status: "not-evaluated",
      notEvaluatedReason: "blocked: this run had no reviewer account.",
    };
    finding.evidenceStatus = "blocked";
    expect(identityRow(placed, null)).toMatchObject({
      status: "blocked",
      detail: "This run had no reviewer account.",
    });
  });

  it("an answer that changed since the check makes it stale", () => {
    const placed = identityResults({
      outcome: "verified",
      call: { tool: "get_me", arguments: {} },
      observed: { organization: "Review Org" },
      expected: { organization: "Review Org" },
    });
    for (const entry of placed.flatMap((step) => step.findings)) {
      entry.evidenceStatus = "stale";
    }
    expect(identityRow(placed, null)).toMatchObject({
      status: "stale",
      detail: "get_me answers for Review Org.",
    });
  });
});

describe("frameOf", () => {
  it("reads the rehearsal's frame names, and nothing else", () => {
    expect(frameOf("res_1#t=12.5")).toEqual({
      recordingId: "res_1",
      seconds: 12.5,
    });
    expect(frameOf("res_1#t=3")).toEqual({ recordingId: "res_1", seconds: 3 });
    expect(frameOf("res_1")).toBeUndefined();
    expect(frameOf("res_1#t=")).toBeUndefined();
    expect(frameOf(undefined)).toBeUndefined();
  });
});

describe("handoverOf", () => {
  /** A rehearsal stopped for a person at `name`, in the rehearsal's words. */
  const stoppedAt = (
    name: "verification" | "consent" | "sign-in",
    reason: string,
  ) =>
    handoverOf(
      attemptIn("waiting-for-person", {
        stages: [OPENED, stage(name, "blocked", reason, 13)],
        waitingFor: {
          reason,
          action: "Sign in as the reviewer yourself, then resume this attempt.",
          since: NOV_13,
        },
      }),
    );

  it("a verification stop: the account must sign in without one, and whoever manages it removes it", () => {
    expect(handoverOf(WAITING)).toEqual({
      asked: ASKED,
      approximated: false,
      frame: { recordingId: "res_1", seconds: 11.2 },
      finisher: "Whoever manages the reviewer account.",
      action:
        "The reviewer account must sign in without a verification step, because directory reviewers can't complete one either. Turn it off for that account, or save credentials for an account that has none. Then resume this attempt.",
      since: NOV_13,
    });
    // Signing in yourself changes nothing for the attempt, so that is never advised.
    expect(handoverOf(WAITING)?.action).not.toBe(ACTION);
  });

  it("a bot check: whoever manages the sign-in turns it off", () => {
    expect(
      stoppedAt(
        "verification",
        'The sign-in page asked for a verification step MCPJam cannot complete: "Confirm you\'re not a robot".',
      ),
    ).toMatchObject({
      finisher: "Whoever manages your server's sign-in.",
      action:
        "Turn the bot check off for the reviewer account or its sign-in. Then resume this attempt.",
    });
  });

  it("a consent page it could not read: one button that approves access", () => {
    const handover = stoppedAt(
      "consent",
      "Approximated: MCPJam could not tell which control on the consent page approves access, so it clicked none.",
    );
    expect(handover).toMatchObject({
      asked:
        "MCPJam could not tell which control on the consent page approves access, so it clicked none.",
      approximated: true,
      finisher: "Whoever manages your server's sign-in.",
      action:
        "Give the consent page one button that approves access, such as Allow. Then resume this attempt.",
    });
  });

  it("any other stop: a sign-in that asks only for an email and password", () => {
    expect(
      stoppedAt(
        "sign-in",
        "MCPJam did not recognize a page in the sign-in, so it stopped.",
      ),
    ).toMatchObject({
      finisher: "Whoever manages your server's sign-in.",
      action:
        "Change the sign-in so it asks the reviewer only for an email and password. Then resume this attempt.",
    });
  });

  it("there is no handover unless the attempt waits for a person", () => {
    expect(handoverOf(null)).toBeNull();
    expect(handoverOf(PASSED)).toBeNull();
    expect(handoverOf(REFUSED)).toBeNull();
    expect(handoverOf({ ...WAITING, waitingFor: undefined })).toBeNull();
    // What it waited for goes with the state, even on a read that kept it.
    expect(handoverOf({ ...WAITING, state: "cancelled" })).toBeNull();
  });
});

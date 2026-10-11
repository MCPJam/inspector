import { describe, expect, it } from "vitest";
import {
  isAnotherUsersReopenedThread,
  isLocalHarnessScope,
} from "../local-harness-scope";

/**
 * WHERE local Claude Code execution is even a question.
 *
 * The failure mode this predicate exists to prevent is INHERITANCE: a surface
 * or a host that has nothing to do with local execution acquiring a local
 * authorization requirement it can never satisfy, and blocking Send forever
 * with no way for the user to find out why.
 */

const IN_SCOPE = { harnessId: "claude-code", hostedMode: false, sharedRun: false };

describe("in scope", () => {
  it("is a claude-code host on a local Inspector's direct chat", () => {
    expect(isLocalHarnessScope(IN_SCOPE)).toBe(true);
  });
});

describe("out of scope", () => {
  it.each([
    ["a hosted replica", { ...IN_SCOPE, hostedMode: true }],
    ["a harness with no local runtime", { ...IN_SCOPE, harnessId: "cursor" }],
    ["no harness at all — ordinary emulated chat", { ...IN_SCOPE, harnessId: null }],
    ["an unresolved harness", { ...IN_SCOPE, harnessId: undefined }],
    ["a scenario session", { ...IN_SCOPE, scenarioId: "cbx-1" }],
    ["a shared or replayed run", { ...IN_SCOPE, sharedRun: true }],
  ])("excludes %s", (_label, input) => {
    expect(isLocalHarnessScope(input as never)).toBe(false);
  });

  it("includes every harness with a local runtime, Codex as well as Claude Code", () => {
    // Each is gated separately everywhere else; the shape of the send applies.
    expect(isLocalHarnessScope({ ...IN_SCOPE, harnessId: "codex" })).toBe(true);
    expect(isLocalHarnessScope({ ...IN_SCOPE, harnessId: "claude-code" })).toBe(true);
  });

  it("treats an unknown harness as out of scope, not as a maybe", () => {
    // Guessing permissively here offers local execution on a host that will
    // not run it — the user authorizes something and then it goes elsewhere.
    expect(isLocalHarnessScope({ ...IN_SCOPE, harnessId: "something-new" })).toBe(
      false,
    );
  });
});

describe("the feature flag is deliberately not one of the facts", () => {
  it("answers the same whether or not the flag is on", () => {
    // The flag gates whether SETUP is offered. Folding it in here would make
    // an explicit local request evaporate the moment a flag evaluation
    // changed, which is the silent relocation the whole design removes.
    expect(isLocalHarnessScope(IN_SCOPE)).toBe(true);
  });
});

it("includes a member environment chat served by the web route on a local Inspector", () => { expect(isLocalHarnessScope({ ...IN_SCOPE, environmentId: "env-1", requiresWebChatApi: true })).toBe(true); });

describe("isAnotherUsersReopenedThread", () => {
  it("keeps the user's own reopened chat local", () => {
    // Restoring your chat (rail or reload) and continuing it is the attended
    // session; it must keep "This machine".
    expect(
      isAnotherUsersReopenedThread({ viewingHistory: true, ownerUserId: "u1", currentUserId: "u1" }),
    ).toBe(false);
  });

  it("treats another member's reopened chat as somebody else's turn", () => {
    expect(
      isAnotherUsersReopenedThread({ viewingHistory: true, ownerUserId: "u2", currentUserId: "u1" }),
    ).toBe(true);
  });

  it("stays replay while the owner or the user is unknown", () => {
    expect(
      isAnotherUsersReopenedThread({ viewingHistory: true, ownerUserId: null, currentUserId: "u1" }),
    ).toBe(true);
    expect(
      isAnotherUsersReopenedThread({ viewingHistory: true, ownerUserId: "u1", currentUserId: undefined }),
    ).toBe(true);
  });

  it("is never replay outside a history view", () => {
    expect(
      isAnotherUsersReopenedThread({ viewingHistory: false, ownerUserId: "u2", currentUserId: "u1" }),
    ).toBe(false);
  });
});

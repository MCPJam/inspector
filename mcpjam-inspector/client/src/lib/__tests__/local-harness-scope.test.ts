import { describe, expect, it } from "vitest";
import { isLocalHarnessScope } from "../local-harness-scope";

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
    ["a different harness", { ...IN_SCOPE, harnessId: "codex" }],
    ["no harness at all — ordinary emulated chat", { ...IN_SCOPE, harnessId: null }],
    ["an unresolved harness", { ...IN_SCOPE, harnessId: undefined }],
    ["a scenario session", { ...IN_SCOPE, scenarioId: "cbx-1" }],
    ["an environment run", { ...IN_SCOPE, environmentId: "env-1" }],
    ["a surface forced onto the web route", { ...IN_SCOPE, requiresWebChatApi: true }],
    ["a shared or replayed run", { ...IN_SCOPE, sharedRun: true }],
  ])("excludes %s", (_label, input) => {
    expect(isLocalHarnessScope(input as never)).toBe(false);
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

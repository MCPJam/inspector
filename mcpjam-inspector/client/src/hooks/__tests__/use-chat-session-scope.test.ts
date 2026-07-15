import { describe, expect, it } from "vitest";
import { areHostedSessionScopesEqual } from "../use-chat-session";

// PR3 (Claude Code harness host): switching the previewed host in the Playground
// must FORK the session — otherwise turns under host B append onto host A's
// transcript while resolving against B (mis-attribution). The chat-reset path
// keys off this comparison, so hostId must be a scope dimension.
describe("areHostedSessionScopesEqual — host switch forks the session", () => {
  const base = { projectId: "p1", chatboxId: undefined, hostId: "host-a" };

  it("treats a different previewed hostId as a different scope (⇒ reset)", () => {
    expect(areHostedSessionScopesEqual(base, { ...base, hostId: "host-b" })).toBe(
      false
    );
  });

  it("treats identical scope as equal (⇒ keep the conversation)", () => {
    expect(areHostedSessionScopesEqual(base, { ...base })).toBe(true);
  });

  it("a different project forks; a different chatbox forks", () => {
    expect(
      areHostedSessionScopesEqual(base, { ...base, projectId: "p2" })
    ).toBe(false);
    expect(
      areHostedSessionScopesEqual(base, { ...base, chatboxId: "cbx" })
    ).toBe(false);
  });

  it("does not consider accessVersion (not part of the scope shape)", () => {
    // Only the three identity dims matter — an accessVersion bump elsewhere
    // keeps the same scope and must not tear down the chat.
    expect(
      areHostedSessionScopesEqual(
        { projectId: "p1", hostId: "h" },
        { projectId: "p1", hostId: "h" }
      )
    ).toBe(true);
  });
});

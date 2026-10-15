import { describe, expect, it } from "vitest";
import { sandboxIntentFor } from "../swarm-sandbox.js";
import type { PinnedHostExecutionSpec } from "../../swarm-agent.js";

function target(
  overrides: Partial<PinnedHostExecutionSpec> = {},
): PinnedHostExecutionSpec {
  return {
    hostId: "host-1",
    hostName: "Host",
    hostConfigId: "hc-1",
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: "",
    requireToolApproval: false,
    serverIds: [],
    computer: { kind: "personal" },
    ...overrides,
  } as PinnedHostExecutionSpec;
}

describe("sandboxIntentFor — a harness target that pinned no image", () => {
  it("asks for a terminal box (the control plane boots the default template)", () => {
    expect(sandboxIntentFor(target({ harness: "claude-code" }))).toEqual({
      kind: "provision",
      runtimeKind: "terminal",
    });
  });

  it("refuses an unavailable pin with its launch-time reason, never the default", () => {
    expect(
      sandboxIntentFor(
        target({
          harness: "claude-code",
          computerUnavailableReason: "The image is a personal draft.",
        }),
      ),
    ).toEqual({ kind: "skip", reason: "The image is a personal draft." });
  });

  it("asks for nothing when the harness runs on the member's own machine", () => {
    expect(
      sandboxIntentFor(target({ harness: "claude-code" }), true, true),
    ).toEqual({ kind: "skip" });
  });

  it("asks for nothing for a harness with no computer attached", () => {
    expect(
      sandboxIntentFor(target({ harness: "claude-code", computer: undefined })),
    ).toEqual({ kind: "skip" });
  });

  it("leaves an unpinned bash-only target silently without a shell, as before", () => {
    expect(sandboxIntentFor(target({ builtInToolIds: ["bash"] }))).toEqual({
      kind: "skip",
    });
  });

  it("still boots a pinned harness target from its pin", () => {
    expect(
      sandboxIntentFor(
        target({
          harness: "codex",
          computerEnvironment: {
            environmentId: "env-1",
            environmentBuildId: "bld-1",
          },
        }),
      ),
    ).toEqual({ kind: "provision", runtimeKind: "terminal" });
  });
});

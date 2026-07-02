import { describe, expect, it } from "vitest";
import { harnessRuntimeFingerprint, toToolResultOutput } from "../run-harness-turn";

// Regression: the fingerprint must be STABLE across turns of one chat so the
// session resumes. App/widget chats mutate the system prompt every turn (live
// widget model context), which previously flipped the fingerprint and
// cold-started every such conversation. The fingerprint must depend only on the
// stable, resume-invalidating dimensions: model + server set + permission mode.
describe("harnessRuntimeFingerprint", () => {
  const base = {
    harnessId: "claude-code",
    modelId: "anthropic/claude-opus-4-6",
    selectedServers: ["srv-b", "srv-a"],
    permissionMode: "allow-all",
  };

  it("changes when the harness id changes — a Codex turn must NOT resume a Claude Code lane", () => {
    // Identical model/servers/permission, different runtime ⇒ different lane.
    expect(harnessRuntimeFingerprint(base)).not.toBe(
      harnessRuntimeFingerprint({ ...base, harnessId: "codex" })
    );
  });

  it("is identical across turns with the same model + servers (server order-insensitive)", () => {
    const a = harnessRuntimeFingerprint(base);
    const b = harnessRuntimeFingerprint({
      ...base,
      selectedServers: ["srv-a", "srv-b"], // reversed
    });
    expect(a).toBe(b);
  });

  it("changes when the model changes (fork)", () => {
    expect(harnessRuntimeFingerprint(base)).not.toBe(
      harnessRuntimeFingerprint({
        ...base,
        modelId: "anthropic/claude-haiku-4.5",
      })
    );
  });

  it("changes when the server set changes (fork)", () => {
    expect(harnessRuntimeFingerprint(base)).not.toBe(
      harnessRuntimeFingerprint({ ...base, selectedServers: ["srv-a"] })
    );
  });

  // NOTE: skills are deliberately NOT part of this opaque fingerprint. They are
  // tracked as a SEPARATE `skillsHash` on the Convex harness-session sidecar so a
  // transient skills-fetch failure ("unknown") is distinguishable from "" (empty)
  // and never churns resume. See harnessSessions claim/commit tests.

  it("does NOT depend on the system prompt (app/widget per-turn injection)", () => {
    // The fn no longer accepts a system prompt; passing a stray field changes
    // nothing — the fingerprint is computed purely from model/servers/mode.
    const withStray = harnessRuntimeFingerprint({
      ...base,
      // @ts-expect-error — systemPrompt is intentionally not a parameter anymore
      systemPrompt: "a wildly different per-turn widget prompt",
    });
    expect(withStray).toBe(harnessRuntimeFingerprint(base));
  });
});

// Regression: the harness `tool-result` `.output` (`event.result`) must be
// persisted single-wrapped — matching the emulated engine — not re-wrapped in a
// second `{type:"json",value:...}` envelope. The bug produced the double-nested
// `{type:json,value:{type:json,value:{}}}` seen in broken transcripts.
describe("toToolResultOutput", () => {
  it("wraps a raw structured result once as json", () => {
    expect(toToolResultOutput({ stdout: "ok" }, false)).toEqual({
      type: "json",
      value: { stdout: "ok" },
    });
  });

  it("passes an already-typed json output through (no double-nest)", () => {
    expect(toToolResultOutput({ type: "json", value: { ok: true } }, false)).toEqual({
      type: "json",
      value: { ok: true },
    });
  });

  it("passes an already-typed content output through (computer-use/image)", () => {
    const content = {
      type: "content",
      value: [{ type: "media", data: "…", mediaType: "image/png" }],
    };
    expect(toToolResultOutput(content, false)).toBe(content);
  });

  it("renders an error as error-text", () => {
    expect(toToolResultOutput("boom", true)).toEqual({
      type: "error-text",
      value: "boom",
    });
    expect(toToolResultOutput({ msg: "boom" }, true)).toEqual({
      type: "error-text",
      value: JSON.stringify({ msg: "boom" }),
    });
  });

  it("does not treat a bare {type} (no value) as already-typed", () => {
    expect(toToolResultOutput({ type: "json" }, false)).toEqual({
      type: "json",
      value: { type: "json" },
    });
  });
});

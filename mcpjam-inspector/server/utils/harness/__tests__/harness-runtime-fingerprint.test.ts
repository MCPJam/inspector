import { describe, expect, it } from "vitest";
import {
  harnessRuntimeFingerprint,
  toToolResultOutput,
} from "../run-harness-turn";

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

  // The consented PROFILE is part of the lane. A user who narrows their grant
  // from workspace-edits to read-only must not resume the session that was
  // created under the wider terms — the resumed bridge already exists and keeps
  // whatever it was started with.
  it("changes when the consented permission profile changes", () => {
    const local = {
      ...base,
      permissionMode: "allow-edits",
      localTarget: {
        runtimeId: "rt_1",
        workspaceGrantId: "ws_1",
        policyVersion: "v1",
        permissionProfile: "workspace-edits",
      },
    };
    const narrowed = {
      ...local,
      // Both move together in production — the mode is DERIVED from the
      // profile — but they are asserted separately so neither alone is load
      // bearing.
      permissionMode: "allow-reads",
      localTarget: { ...local.localTarget, permissionProfile: "read-only" },
    };
    expect(harnessRuntimeFingerprint(local)).not.toBe(
      harnessRuntimeFingerprint(narrowed),
    );
    // …and the profile alone forks it, even if a future mapping gave two
    // profiles the same mode.
    expect(harnessRuntimeFingerprint(local)).not.toBe(
      harnessRuntimeFingerprint({
        ...local,
        localTarget: { ...local.localTarget, permissionProfile: "read-only" },
      }),
    );
  });

  it("keeps a hosted turn hashing exactly as it did before local targets existed", () => {
    // `localTarget` is appended only when present, so every existing hosted
    // session keeps resuming across this deploy.
    expect(harnessRuntimeFingerprint(base)).toBe(
      harnessRuntimeFingerprint({ ...base, localTarget: undefined }),
    );
  });

  it("changes when the harness id changes — a Codex turn must NOT resume a Claude Code lane", () => {
    // Identical model/servers/permission, different runtime ⇒ different lane.
    expect(harnessRuntimeFingerprint(base)).not.toBe(
      harnessRuntimeFingerprint({ ...base, harnessId: "codex" }),
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
      }),
    );
  });

  it("changes when the server set changes (fork)", () => {
    expect(harnessRuntimeFingerprint(base)).not.toBe(
      harnessRuntimeFingerprint({ ...base, selectedServers: ["srv-a"] }),
    );
  });

  // NOTE: skills are deliberately NOT part of this opaque fingerprint. They are
  // tracked as a SEPARATE `skillsHash` on the Convex harness-session sidecar so a
  // transient skills-fetch failure ("unknown") is distinguishable from "" (empty)
  // and never churns resume. See harnessSessions claim/commit tests.

  // INS-7: the plugin runtime is a resume-invalidating dimension. A resumed
  // sandbox still holds the plugin material delivered when it was created.
  const pluginA = {
    pluginId: "plg_1",
    pluginVersionId: "pv_1",
    name: "weather",
    bundleHash: "hash-a",
  };

  it("is unchanged by an EMPTY/absent plugin set — existing sessions must not cold-start", () => {
    expect(harnessRuntimeFingerprint({ ...base, pluginVersions: [] })).toBe(
      harnessRuntimeFingerprint(base),
    );
  });

  it("changes when a plugin is pinned at all (plugin-less lane is not compatible)", () => {
    expect(
      harnessRuntimeFingerprint({ ...base, pluginVersions: [pluginA] }),
    ).not.toBe(harnessRuntimeFingerprint(base));
  });

  it("changes when the pinned plugin VERSION changes, even with the same server set", () => {
    expect(
      harnessRuntimeFingerprint({ ...base, pluginVersions: [pluginA] }),
    ).not.toBe(
      harnessRuntimeFingerprint({
        ...base,
        pluginVersions: [{ ...pluginA, pluginVersionId: "pv_2" }],
      }),
    );
  });

  it("changes when the plugin BUNDLE CONTENT changes under the same version id", () => {
    expect(
      harnessRuntimeFingerprint({ ...base, pluginVersions: [pluginA] }),
    ).not.toBe(
      harnessRuntimeFingerprint({
        ...base,
        pluginVersions: [{ ...pluginA, bundleHash: "hash-b" }],
      }),
    );
  });

  it("is insensitive to pin ORDER (same runtime ⇒ same lane)", () => {
    const pluginB = { ...pluginA, pluginVersionId: "pv_2", name: "maps" };
    expect(
      harnessRuntimeFingerprint({
        ...base,
        pluginVersions: [pluginA, pluginB],
      }),
    ).toBe(
      harnessRuntimeFingerprint({
        ...base,
        pluginVersions: [pluginB, pluginA],
      }),
    );
  });

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
    expect(
      toToolResultOutput({ type: "json", value: { ok: true } }, false),
    ).toEqual({
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

/**
 * The THIRD state of the secrets fetch.
 *
 * `secretsHash` present  ⇒ these exact secrets were delivered.
 * `secretsHash` absent   ⇒ the caller established there are none; resume.
 * `secretsHash` sentinel ⇒ the caller could not find out.
 *
 * The third must not collapse into the second. Resuming there reattaches to a
 * bridge that may still hold previously delivered values — which the turn cannot
 * enumerate and so cannot scrub out of the transcript. Forking gives a fresh
 * bridge holding nothing.
 */
describe("harnessRuntimeFingerprint — the secrets dimension", () => {
  const base = {
    harnessId: "claude-code",
    modelId: "anthropic/claude-opus-4-6",
    selectedServers: ["srv-a"],
    permissionMode: "allow-all",
  };

  it("forks a session that HAD secrets when they can no longer be resolved", () => {
    const delivered = harnessRuntimeFingerprint({
      ...base,
      secretsHash: "abc123",
    });
    const unresolvable = harnessRuntimeFingerprint({
      ...base,
      secretsHash: "unavailable",
    });
    expect(unresolvable).not.toBe(delivered);
  });

  it("does not read as 'the secrets were removed'", () => {
    // A turn that legitimately has none omits the dimension and resumes. The
    // unresolved case must differ from that too, or a failed fetch would
    // silently resume onto the bridge it was supposed to leave behind.
    const none = harnessRuntimeFingerprint(base);
    const unresolvable = harnessRuntimeFingerprint({
      ...base,
      secretsHash: "unavailable",
    });
    expect(unresolvable).not.toBe(none);
  });

  it("is stable across consecutive unresolved turns", () => {
    // The sentinel is a constant on purpose: two failed turns in a row resume
    // onto each other, which is right — neither delivered anything.
    expect(
      harnessRuntimeFingerprint({ ...base, secretsHash: "unavailable" }),
    ).toBe(harnessRuntimeFingerprint({ ...base, secretsHash: "unavailable" }));
  });
});

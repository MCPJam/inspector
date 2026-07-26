import { describe, expect, it } from "vitest";
import { normalizeExecutionTarget } from "../execution-target";

describe("normalizeExecutionTarget", () => {
  it("REJECTS chatboxId + executionTarget instead of shadowing one", () => {
    // The whole point of the normalizer: a body with two pointers must not
    // execute against one of them silently.
    const result = normalizeExecutionTarget({
      chatboxId: "cbx_1",
      executionTarget: { kind: "environment", environmentId: "env_1" },
      projectId: "p_1",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cannot be combined/i);
  });

  it("REJECTS legacy hostId + executionTarget", () => {
    const result = normalizeExecutionTarget({
      hostId: "host_1",
      executionTarget: { kind: "host", hostId: "host_1" },
      projectId: "p_1",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cannot be combined/i);
  });

  it("uses an explicit executionTarget", () => {
    expect(
      normalizeExecutionTarget({
        executionTarget: { kind: "environment", environmentId: "env_1" },
        projectId: "p_1",
      })
    ).toEqual({
      ok: true,
      target: { kind: "environment", environmentId: "env_1" },
    });
    expect(
      normalizeExecutionTarget({
        executionTarget: { kind: "host", hostId: "host_1" },
        projectId: "p_1",
      })
    ).toEqual({ ok: true, target: { kind: "host", hostId: "host_1" } });
  });

  it("normalizes a legacy hostId to a host target", () => {
    expect(
      normalizeExecutionTarget({ hostId: "host_1", projectId: "p_1" })
    ).toEqual({ ok: true, target: { kind: "host", hostId: "host_1" } });
  });

  it("keeps chatbox precedence over a stray legacy hostId (unchanged legacy behavior)", () => {
    expect(
      normalizeExecutionTarget({
        chatboxId: "cbx_1",
        hostId: "host_1",
        projectId: "p_1",
      })
    ).toEqual({ ok: true, target: { kind: "chatbox", chatboxId: "cbx_1" } });
  });

  it("falls through to the ad-hoc direct chat when nothing points anywhere", () => {
    expect(normalizeExecutionTarget({ projectId: "p_1" })).toEqual({
      ok: true,
      target: { kind: "adhoc", projectId: "p_1" },
    });
  });

  it("treats an empty-string pointer as absent, not as a target", () => {
    expect(
      normalizeExecutionTarget({
        hostId: "",
        chatboxId: "  ",
        projectId: "p_1",
      })
    ).toEqual({ ok: true, target: { kind: "adhoc", projectId: "p_1" } });
  });

  it("rejects a malformed executionTarget rather than ignoring it", () => {
    for (const bad of [
      { kind: "environment" },
      { kind: "host" },
      { kind: "workspace", workspaceId: "w_1" },
      "environment",
      [],
    ]) {
      const result = normalizeExecutionTarget({
        executionTarget: bad,
        projectId: "p_1",
      });
      expect(result.ok).toBe(false);
    }
  });

  it("carries environment overrides, keeping ABSENT distinct from []", () => {
    // Absent ⇒ use the environment's own set.
    const absent = normalizeExecutionTarget({
      executionTarget: { kind: "environment", environmentId: "env_1" },
      projectId: "p_1",
    });
    expect(absent.ok && absent.target).toEqual({
      kind: "environment",
      environmentId: "env_1",
    });

    // `[]` ⇒ a real override meaning "no MCP servers this turn".
    const empty = normalizeExecutionTarget({
      executionTarget: { kind: "environment", environmentId: "env_1" },
      environmentOverrides: { serverIds: [] },
      projectId: "p_1",
    });
    expect(empty.ok && empty.target).toEqual({
      kind: "environment",
      environmentId: "env_1",
      overrides: { serverIds: [] },
    });

    const some = normalizeExecutionTarget({
      executionTarget: { kind: "environment", environmentId: "env_1" },
      environmentOverrides: { serverIds: ["ps_1"] },
      projectId: "p_1",
    });
    expect(some.ok && some.target).toEqual({
      kind: "environment",
      environmentId: "env_1",
      overrides: { serverIds: ["ps_1"] },
    });
  });

  it("rejects environment overrides sent without an environment target", () => {
    for (const ingress of [
      { environmentOverrides: { serverIds: ["ps_1"] }, projectId: "p_1" },
      {
        executionTarget: { kind: "host", hostId: "host_1" },
        environmentOverrides: { serverIds: ["ps_1"] },
        projectId: "p_1",
      },
    ]) {
      const result = normalizeExecutionTarget(ingress);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(
        /requires an environment/i
      );
    }
  });

  it("rejects a malformed override envelope", () => {
    const result = normalizeExecutionTarget({
      executionTarget: { kind: "environment", environmentId: "env_1" },
      environmentOverrides: { serverIds: ["ok", 3] },
      projectId: "p_1",
    });
    expect(result.ok).toBe(false);
  });
});

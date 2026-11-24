/**
 * The ONE builder for `getToolsForAiSdk`'s host-derived options.
 *
 * These assertions pin the property that every call site depends on and that a
 * fifth (the harness host-executed projection) silently violated by building
 * nothing at all: absent-everything answers `undefined`, so a default turn
 * takes the no-options overload and produces byte-identical tools.
 */
import { describe, expect, it } from "vitest";
import { mcpToolOptionsFor } from "../mcp-tool-options";

describe("mcpToolOptionsFor", () => {
  it("answers undefined when no host input applies", () => {
    expect(mcpToolOptionsFor({})).toBeUndefined();
    expect(
      mcpToolOptionsFor({
        needsApproval: false,
        includeAppOnly: false,
        modelVisibleMcpToolResults: undefined,
        tasks: undefined,
      })
    ).toBeUndefined();
  });

  it("omits a field rather than writing a falsy default", () => {
    // `{ includeAppOnly: false }` and `{ needsApproval: false }` are the SDK's
    // own defaults; writing them would make an all-default turn take the
    // options overload for no reason.
    expect(mcpToolOptionsFor({ needsApproval: true })).toEqual({
      needsApproval: true,
    });
    expect(mcpToolOptionsFor({ includeAppOnly: true })).toEqual({
      includeAppOnly: true,
    });
  });

  it("carries a defined policy object through unchanged", () => {
    const policy = { directContent: { image: true } } as never;
    expect(
      mcpToolOptionsFor({ modelVisibleMcpToolResults: policy })
    ).toEqual({ modelVisibleMcpToolResults: policy });
  });

  it("treats an absent task seam as tasks-off", () => {
    // `task-seam.ts` returns `undefined` for "this surface must not run tasks",
    // and that is the same value a caller passes for "no tasks" — one disabled
    // path, and it must not put a `tasks` key on the wire.
    expect(mcpToolOptionsFor({ tasks: undefined })).toBeUndefined();
    const seam = { mode: "await" } as never;
    expect(mcpToolOptionsFor({ tasks: seam })).toEqual({ tasks: seam });
  });

  /**
   * `toolCallCancellation` is the ONE field here where absent and empty are
   * different instructions, so it gets its own case rather than riding along
   * with the policy-object one.
   *
   * `applyCancellationPolicy` reads `override ?? config?.toolCallCancellation`.
   * Absent therefore falls through to the connection's connect-time copy — the
   * stale value the per-turn override exists to beat — while `{}` overrides it
   * with "no era is suppressed". Both chat routes send `{}` whenever a host
   * config resolved, so if this builder ever dropped the empty record (which
   * the `Object.keys` rule would do the moment the field stopped being
   * counted) a host toggled back ON would keep suppressing. That was the bug.
   */
  it("keeps an EMPTY cancellation record, which is not the same as absent", () => {
    expect(mcpToolOptionsFor({ toolCallCancellation: {} })).toEqual({
      toolCallCancellation: {},
    });
    // ...and absent still answers undefined, so a default turn keeps taking
    // the no-options overload.
    expect(
      mcpToolOptionsFor({ toolCallCancellation: undefined })
    ).toBeUndefined();
  });

  it("carries a cancellation record through unchanged", () => {
    const leaves = { legacy: false, modern: false };
    expect(mcpToolOptionsFor({ toolCallCancellation: leaves })).toEqual({
      toolCallCancellation: leaves,
    });
    expect(
      mcpToolOptionsFor({ toolCallCancellation: { modern: false } })
    ).toEqual({ toolCallCancellation: { modern: false } });
  });

  it("reproduces the emulated engine's full object", () => {
    // The shape `chat-v2-orchestration` built by hand before this helper
    // existed, from the same host-derived inputs.
    const policy = { directContent: { image: false } } as never;
    const seam = { mode: "detach" } as never;
    expect(
      mcpToolOptionsFor({
        needsApproval: true,
        includeAppOnly: true,
        modelVisibleMcpToolResults: policy,
        tasks: seam,
        toolCallCancellation: { modern: false },
      })
    ).toEqual({
      needsApproval: true,
      includeAppOnly: true,
      modelVisibleMcpToolResults: policy,
      tasks: seam,
      toolCallCancellation: { modern: false },
    });
  });
});

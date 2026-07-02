/**
 * Contract tests for `resolveExecutionContext` (PR 4c of the engine
 * consolidation in `~/mcpjam-docs/unification.md`).
 *
 * Purpose: lock the resolver shape that chat-v2 (mcp + web) will swap
 * its inline hostConfig reads onto in this PR, and that eval will swap
 * its `advancedConfig.system`-only resolution onto in PR 4d (closing
 * the suite-systemPrompt gap).
 *
 * Tests cover every precedence + hostConfig + overrides permutation
 * the live callers actually hit:
 *
 *   - `host-wins` with full hostConfig (chat chatbox path).
 *   - `host-wins` with null hostConfig (chat direct path — degenerate).
 *   - `override-wins` with hostConfig + overrides (eval per-case).
 *   - Optional-only host fields (older backends omitting
 *     `progressiveToolDiscovery` / `respectToolVisibility`).
 *   - Drift surfacing — both sides defined and disagree.
 *   - Drift NOT surfacing — same value on both sides.
 *   - Default semantics for `requireToolApproval` (must be a boolean,
 *     never undefined).
 *   - Progressive discovery dual shape (plain boolean vs
 *     `{enabled, ...}` wire shape).
 *   - hostPolicy threading through unchanged from
 *     `extractHostExecutionPolicy`.
 */
import { describe, expect, it } from "vitest";
import { resolveExecutionContext } from "../host-execution-context";

describe("resolveExecutionContext — harness (host-only, server-authoritative)", () => {
  it("reads harness from hostConfig, never from overrides, under override-wins", () => {
    // The Playground (host-bound direct) path uses override-wins so the owner's
    // in-session tweaks win — but harness/computer must still come from the host
    // config, never the body. `overrides` has no harness field, so this also
    // proves the resolver can't be tricked into sourcing it from the body.
    const result = resolveExecutionContext({
      hostConfig: {
        systemPrompt: "host prompt",
        harness: "claude-code",
      },
      overrides: {
        systemPrompt: "body prompt",
        temperature: 0.3,
      },
      precedence: "override-wins",
    });
    // Body tweak wins for overridable fields...
    expect(result.systemPrompt).toBe("body prompt");
    expect(result.temperature).toBe(0.3);
    // ...but harness is host-only.
    expect(result.harness).toBe("claude-code");
  });

  it("yields harness undefined for a non-harness host (emulated path)", () => {
    const result = resolveExecutionContext({
      hostConfig: { systemPrompt: "host prompt" },
      overrides: {},
      precedence: "override-wins",
    });
    expect(result.harness).toBeUndefined();
  });

  it("ignores an unknown harness value (closed read)", () => {
    const result = resolveExecutionContext({
      hostConfig: { harness: "totally-not-a-harness" },
      overrides: {},
      precedence: "host-wins",
    });
    expect(result.harness).toBeUndefined();
  });

  it("reads the codex harness (membership via the SDK source of truth)", () => {
    const result = resolveExecutionContext({
      hostConfig: { harness: "codex" },
      overrides: {},
      precedence: "host-wins",
    });
    expect(result.harness).toBe("codex");
  });

  it("yields harness undefined when hostConfig is null (plain direct chat)", () => {
    const result = resolveExecutionContext({
      hostConfig: null,
      overrides: { systemPrompt: "body" },
      precedence: "override-wins",
    });
    expect(result.harness).toBeUndefined();
  });
});

describe("resolveExecutionContext — `host-wins` precedence (chat chatbox)", () => {
  it("returns hostConfig values verbatim when host carries every field", () => {
    const result = resolveExecutionContext({
      hostConfig: {
        systemPrompt: "host system prompt",
        temperature: 0.42,
        requireToolApproval: true,
        respectToolVisibility: false,
        progressiveToolDiscovery: true,
        modelId: "claude-haiku-4.5",
        selectedServerIds: ["srv-1", "srv-2"],
      },
      overrides: {
        systemPrompt: "body system prompt",
        temperature: 0.99,
        requireToolApproval: false,
        respectToolVisibility: true,
        progressiveToolDiscovery: false,
        modelId: "gpt-4-turbo",
        selectedServerIds: ["other-srv"],
      },
      precedence: "host-wins",
    });

    expect(result.systemPrompt).toBe("host system prompt");
    expect(result.temperature).toBe(0.42);
    expect(result.requireToolApproval).toBe(true);
    expect(result.respectToolVisibility).toBe(false);
    expect(result.progressiveToolDiscovery).toBe(true);
    expect(result.modelId).toBe("claude-haiku-4.5");
    expect(result.selectedServerIds).toEqual(["srv-1", "srv-2"]);
  });

  it("falls back to overrides when host omits a field", () => {
    // Older backends (pre-mcpjam-backend PR #334) omit
    // `progressiveToolDiscovery`. `host-wins` precedence must NOT
    // clobber the override with undefined just because host is silent;
    // it should fall back to the override.
    const result = resolveExecutionContext({
      hostConfig: {
        systemPrompt: "host system prompt",
        temperature: 0.5,
        requireToolApproval: true,
        // progressiveToolDiscovery + respectToolVisibility omitted.
      },
      overrides: {
        progressiveToolDiscovery: true,
        respectToolVisibility: false,
      },
      precedence: "host-wins",
    });

    expect(result.progressiveToolDiscovery).toBe(true);
    expect(result.respectToolVisibility).toBe(false);
    expect(result.systemPrompt).toBe("host system prompt");
  });

  it("falls back to overrides when hostConfig is null (direct chat path)", () => {
    // mcp/chat-v2 direct chat (non-chatbox) skips
    // `fetchChatboxRuntimeConfig`; callers pass `hostConfig: null` and
    // the resolver returns the body fields unmodified.
    const result = resolveExecutionContext({
      hostConfig: null,
      overrides: {
        systemPrompt: "body system prompt",
        temperature: 0.3,
        requireToolApproval: false,
        selectedServerIds: ["srv-A"],
      },
      precedence: "host-wins",
    });

    expect(result.systemPrompt).toBe("body system prompt");
    expect(result.temperature).toBe(0.3);
    expect(result.requireToolApproval).toBe(false);
    expect(result.selectedServerIds).toEqual(["srv-A"]);
  });

  it("emits a drift entry when override and host disagree", () => {
    // Chat-v2 logs a per-field `logger.warn` when the body's
    // `requireToolApproval` differs from the host's value. The
    // resolver surfaces this as data so callers can decide whether to
    // log. Drift is reported even though `host-wins` precedence makes
    // the host value the winner — the SIGNAL is that the body tried.
    const result = resolveExecutionContext({
      hostConfig: { requireToolApproval: true },
      overrides: { requireToolApproval: false },
      precedence: "host-wins",
    });

    expect(result.requireToolApproval).toBe(true);
    expect(result.drift).toEqual([
      {
        field: "requireToolApproval",
        overrideValue: false,
        hostValue: true,
      },
    ]);
  });

  it("does NOT emit drift when override and host agree", () => {
    const result = resolveExecutionContext({
      hostConfig: {
        systemPrompt: "same",
        temperature: 0.5,
      },
      overrides: {
        systemPrompt: "same",
        temperature: 0.5,
      },
      precedence: "host-wins",
    });

    expect(result.drift).toEqual([]);
  });

  it("does NOT emit drift when only one side has a value", () => {
    // Pure fallback isn't drift — only meaningful when BOTH sides set
    // and disagreed.
    const result = resolveExecutionContext({
      hostConfig: { systemPrompt: "host only" },
      overrides: { temperature: 0.7 },
      precedence: "host-wins",
    });

    expect(result.systemPrompt).toBe("host only");
    expect(result.temperature).toBe(0.7);
    expect(result.drift).toEqual([]);
  });
});

describe("resolveExecutionContext — `override-wins` precedence (eval per-case)", () => {
  it("returns override values when both host and override define a field", () => {
    // Eval per-case `advancedConfig.system` beats suite hostConfig
    // default — the per-case override is the authoritative value, the
    // suite default is a fallback.
    const result = resolveExecutionContext({
      hostConfig: {
        systemPrompt: "suite default system prompt",
        temperature: 0.5,
      },
      overrides: {
        systemPrompt: "per-case system prompt",
        temperature: 0.9,
      },
      precedence: "override-wins",
    });

    expect(result.systemPrompt).toBe("per-case system prompt");
    expect(result.temperature).toBe(0.9);
    // Drift is still reported — the eval runner may stash it on
    // iteration metadata for observability.
    expect(result.drift).toEqual(
      expect.arrayContaining([
        {
          field: "systemPrompt",
          overrideValue: "per-case system prompt",
          hostValue: "suite default system prompt",
        },
        {
          field: "temperature",
          overrideValue: 0.9,
          hostValue: 0.5,
        },
      ]),
    );
  });

  it("falls back to host value when override is undefined", () => {
    // The eval design comment at
    // client/src/components/evals/use-eval-handlers.ts:302 says: per-case
    // advancedConfig deliberately does NOT bake the suite default in
    // (to avoid stale copies). The runtime applies the suite default at
    // resolution time — this test locks that behavior.
    const result = resolveExecutionContext({
      hostConfig: {
        systemPrompt: "suite default",
        temperature: 0.5,
      },
      overrides: {
        // systemPrompt + temperature intentionally undefined.
        modelId: "gpt-4-turbo",
      },
      precedence: "override-wins",
    });

    expect(result.systemPrompt).toBe("suite default");
    expect(result.temperature).toBe(0.5);
    expect(result.modelId).toBe("gpt-4-turbo");
  });
});

describe("resolveExecutionContext — `requireToolApproval` default semantic", () => {
  it("defaults to false when neither host nor override sets it", () => {
    // `requireToolApproval` is a boolean-required slot — undefined is
    // not a valid output. Mirrors `extractHostExecutionPolicy`'s
    // default. Without this default downstream code (chat-v2's
    // orchestrator) would treat `undefined` as falsy and inconsistency
    // could creep in.
    const result = resolveExecutionContext({
      hostConfig: null,
      precedence: "host-wins",
    });

    expect(result.requireToolApproval).toBe(false);
  });

  it("respects an explicit false from overrides when host is null", () => {
    const result = resolveExecutionContext({
      hostConfig: null,
      overrides: { requireToolApproval: false },
      precedence: "host-wins",
    });

    expect(result.requireToolApproval).toBe(false);
  });

  it("respects an explicit true from overrides when host is null", () => {
    const result = resolveExecutionContext({
      hostConfig: null,
      overrides: { requireToolApproval: true },
      precedence: "host-wins",
    });

    expect(result.requireToolApproval).toBe(true);
  });
});

describe("resolveExecutionContext — `progressiveToolDiscovery` dual shape", () => {
  it("reads a plain boolean from hostConfigV2 records", () => {
    // HostConfigV2 storage shape.
    const result = resolveExecutionContext({
      hostConfig: { progressiveToolDiscovery: true },
      precedence: "host-wins",
    });

    expect(result.progressiveToolDiscovery).toBe(true);
    expect(result.hostPolicy.progressiveDiscoveryEnabled).toBe(true);
  });

  it("reads `{enabled: true}` from chat-v2 wire payloads", () => {
    // Chat-v2 wraps the field as `{ enabled, threshold }`. Mirror
    // `extractHostExecutionPolicy`'s dual read.
    const result = resolveExecutionContext({
      hostConfig: {
        progressiveToolDiscovery: { enabled: true, threshold: 0.03 },
      },
      precedence: "host-wins",
    });

    expect(result.progressiveToolDiscovery).toBe(true);
    expect(result.hostPolicy.progressiveDiscoveryEnabled).toBe(true);
  });

  it("returns false when wire payload sets `{enabled: false}`", () => {
    const result = resolveExecutionContext({
      hostConfig: {
        progressiveToolDiscovery: { enabled: false },
      },
      precedence: "host-wins",
    });

    expect(result.progressiveToolDiscovery).toBe(false);
  });

  it("treats invalid wire shapes as undefined", () => {
    const result = resolveExecutionContext({
      hostConfig: {
        // Bad shape — not a boolean, not a `{enabled}` record.
        progressiveToolDiscovery: "yes",
      },
      precedence: "host-wins",
    });

    expect(result.progressiveToolDiscovery).toBeUndefined();
  });
});

describe("resolveExecutionContext — type coercion guards", () => {
  it("ignores non-string systemPrompt on hostConfig", () => {
    const result = resolveExecutionContext({
      hostConfig: { systemPrompt: 42 },
      overrides: { systemPrompt: "fallback" },
      precedence: "host-wins",
    });

    expect(result.systemPrompt).toBe("fallback");
  });

  it("ignores non-number temperature on hostConfig", () => {
    const result = resolveExecutionContext({
      hostConfig: { temperature: "0.5" },
      overrides: { temperature: 0.7 },
      precedence: "host-wins",
    });

    expect(result.temperature).toBe(0.7);
  });

  it("ignores non-string-array selectedServerIds on hostConfig", () => {
    const result = resolveExecutionContext({
      hostConfig: { selectedServerIds: ["srv-1", 42, "srv-3"] },
      overrides: { selectedServerIds: ["fallback"] },
      precedence: "host-wins",
    });

    expect(result.selectedServerIds).toEqual(["fallback"]);
  });

  it("ignores non-string-array builtInToolIds on hostConfig", () => {
    const result = resolveExecutionContext({
      hostConfig: { builtInToolIds: ["web_search", 7] },
      precedence: "host-wins",
    });

    expect(result.builtInToolIds).toBeUndefined();
  });
});

describe("resolveExecutionContext — builtInToolIds", () => {
  it("reads builtInToolIds from the hostConfig record", () => {
    const result = resolveExecutionContext({
      hostConfig: { builtInToolIds: ["web_search"] },
      precedence: "host-wins",
    });

    expect(result.builtInToolIds).toEqual(["web_search"]);
  });

  it("falls back to the override when the host omits the field", () => {
    const result = resolveExecutionContext({
      hostConfig: {},
      overrides: { builtInToolIds: ["web_search"] },
      precedence: "host-wins",
    });

    expect(result.builtInToolIds).toEqual(["web_search"]);
  });

  it("host wins under host-wins precedence when both define the field", () => {
    // An explicit empty array on the host record is a real "no built-ins"
    // opinion — it must beat a body that tries to opt in.
    const result = resolveExecutionContext({
      hostConfig: { builtInToolIds: [] },
      overrides: { builtInToolIds: ["web_search"] },
      precedence: "host-wins",
    });

    expect(result.builtInToolIds).toEqual([]);
  });

  it("returns the override on a null hostConfig (direct chat path)", () => {
    const result = resolveExecutionContext({
      hostConfig: null,
      overrides: { builtInToolIds: ["web_search"] },
      precedence: "host-wins",
    });

    expect(result.builtInToolIds).toEqual(["web_search"]);
  });

  it("is undefined when neither side defines it", () => {
    const result = resolveExecutionContext({
      hostConfig: {},
      precedence: "host-wins",
    });

    expect(result.builtInToolIds).toBeUndefined();
  });

  it("does NOT report drift for array fields with equal contents", () => {
    // Arrays arrive as fresh allocations on every request — drift must
    // compare values, not references.
    const result = resolveExecutionContext({
      hostConfig: {
        builtInToolIds: ["web_search"],
        selectedServerIds: ["srv-1"],
      },
      overrides: {
        builtInToolIds: ["web_search"],
        selectedServerIds: ["srv-1"],
      },
      precedence: "host-wins",
    });

    expect(result.drift).toEqual([]);
  });

  it("reports drift for array fields with differing contents", () => {
    const result = resolveExecutionContext({
      hostConfig: { builtInToolIds: [] },
      overrides: { builtInToolIds: ["web_search"] },
      precedence: "host-wins",
    });

    expect(result.drift).toEqual([
      {
        field: "builtInToolIds",
        overrideValue: ["web_search"],
        hostValue: [],
      },
    ]);
  });
});

describe("resolveExecutionContext — hostPolicy passthrough", () => {
  it("forwards `extractHostExecutionPolicy`'s shape unchanged", () => {
    // The resolver computes `hostPolicy` via the existing SDK helper so
    // chat/eval can keep using `buildHostIterationMetadata` etc.
    // without changes. This test asserts the policy shape matches the
    // SDK helper's output for the same input.
    const result = resolveExecutionContext({
      hostConfig: {
        requireToolApproval: true,
        respectToolVisibility: false,
        progressiveToolDiscovery: true,
        hostStyle: "claude",
      },
      precedence: "host-wins",
      namedHostId: "host-abc",
    });

    expect(result.hostPolicy).toEqual({
      requireToolApproval: true,
      respectToolVisibility: false,
      progressiveDiscoveryEnabled: true,
      hostStyle: "claude",
      namedHostId: "host-abc",
    });
  });

  it("emits a null-hostConfig hostPolicy when hostConfig is null", () => {
    const result = resolveExecutionContext({
      hostConfig: null,
      precedence: "host-wins",
      namedHostId: "host-xyz",
    });

    expect(result.hostPolicy).toEqual({
      requireToolApproval: false,
      respectToolVisibility: undefined,
      progressiveDiscoveryEnabled: false,
      hostStyle: undefined,
      namedHostId: "host-xyz",
    });
  });
});

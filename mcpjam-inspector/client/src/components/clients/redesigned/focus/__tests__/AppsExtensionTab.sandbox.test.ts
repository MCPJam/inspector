import { describe, expect, it } from "vitest";
import {
  emptyHostConfigInputV2,
  resolveEffectiveHostCapabilities,
} from "@/lib/client-config-v2";
import { applyJsonToDraft } from "../AppsExtensionTab";
import {
  focusTabForNodeId,
  SANDBOX_HUB_NODE_ID,
  sandboxConfigLeafNodeId,
} from "../../types";

describe("focusTabForNodeId — sandbox routing", () => {
  it("routes the sandbox hub id to the Apps Extension tab", () => {
    expect(focusTabForNodeId(SANDBOX_HUB_NODE_ID)).toEqual({
      tab: "apps",
      selectedServerId: null,
    });
  });

  it("routes every sandbox leaf node id to the Apps Extension tab and carries the subKey through as focusSubKey", () => {
    for (const sub of [
      "mode",
      "restrictTo",
      "cspDirectives",
      "permissions",
      "sandboxAttrs",
      "allowFeatures",
    ] as const) {
      expect(focusTabForNodeId(sandboxConfigLeafNodeId(sub))).toEqual({
        tab: "apps",
        selectedServerId: null,
        focusSubKey: sub,
      });
    }
  });

  it("still routes apps-cap clicks to apps (no startsWith() bleed)", () => {
    expect(focusTabForNodeId("apps-cap:openLinks")?.tab).toBe("apps");
  });
});

describe("AppsExtensionTab — sandbox JSON round-trip", () => {
  it("reads the four spec CSP allowlists from spec position into restrictTo storage", () => {
    // The user types SEP-1865 shape: the four allowlists live directly
    // under `sandbox.csp` (no `restrictTo` wrapper) so they map to
    // `HostCapabilities.sandbox.csp.{connectDomains, ...}` 1:1.
    // Internally we still store as `csp.restrictTo` because the inspector
    // layers a `mode` knob on top.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {
          csp: {
            connectDomains: ["https://api.openai.com"],
            resourceDomains: ["https://cdn.jsdelivr.net"],
          },
          permissions: { clipboardWrite: {}, microphone: {} },
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.restrictTo).toEqual({
      connectDomains: ["https://api.openai.com"],
      resourceDomains: ["https://cdn.jsdelivr.net"],
    });
    expect(next?.mcpProfile?.apps?.sandbox?.permissions?.allow).toEqual({
      clipboardWrite: true,
      microphone: true,
    });
  });

  it("preserves inspector-only mode on edit (not surfaced in JSON, can't be wiped from it)", () => {
    // Regression: `mode` is an inspector knob (not in SEP-1865). The JSON
    // surfaces enforcement, not internal resolver state. Editing JSON
    // must not nuke `mode`.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            mode: "relaxed",
            restrictTo: { connectDomains: ["https://api.openai.com"] },
          },
          permissions: { mode: "custom" },
        },
      },
    };
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {
          csp: { connectDomains: ["https://api.anthropic.com"] },
        },
      },
      prev,
    );
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.mode).toBe("relaxed");
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.restrictTo).toEqual({
      connectDomains: ["https://api.anthropic.com"],
    });
    expect(next?.mcpProfile?.apps?.sandbox?.permissions?.mode).toBe("custom");
  });

  it("treats absent sandbox key as 'no change' (preserves prev sandbox verbatim)", () => {
    // A no-op apps-tab save (user opened the tab, didn't touch sandbox,
    // pressed save) parses JSON without a sandbox key. Sandbox must
    // round-trip untouched.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            mode: "declared",
            restrictTo: { connectDomains: ["https://x"] },
          },
          permissions: { allow: { clipboardWrite: true } },
        },
      },
    };
    const next = applyJsonToDraft({ hostContext: {} }, prev);
    expect(next?.mcpProfile?.apps?.sandbox).toEqual(
      prev.mcpProfile.apps!.sandbox,
    );
  });

  it("treats empty sandbox block as 'clear surfaced fields' but keeps mode", () => {
    // The user explicitly emptied the sandbox block. That should drop
    // restrictTo/allow/directiveOverrides/sandboxAttrs/permissionsPolicy
    // but keep `mode` so the user doesn't lose inspector-internal state.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            mode: "relaxed",
            restrictTo: { connectDomains: ["https://x"] },
          },
          permissions: {
            mode: "custom",
            allow: { clipboardWrite: true },
          },
        },
      },
    };
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {},
      },
      prev,
    );
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.restrictTo).toBeUndefined();
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.mode).toBe("relaxed");
    expect(next?.mcpProfile?.apps?.sandbox?.permissions?.allow).toBeUndefined();
    expect(next?.mcpProfile?.apps?.sandbox?.permissions?.mode).toBe("custom");
  });

  it("treats permission VALUE being absent as 'not granted' (spec semantics)", () => {
    // Per SEP-1865, `camera: {}` granted; absence = not granted. There's
    // no 'false' representation — a missing key means denied.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {
          permissions: { clipboardWrite: {} },
          // microphone absent → not granted
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.sandbox?.permissions?.allow).toEqual({
      clipboardWrite: true,
    });
  });

  it("preserves initialize.clientInfo (owned by ProtocolTab) when sandbox is edited", () => {
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      initialize: { clientInfo: { name: "claude-ai", version: "0.1.0" } },
      apps: { sandbox: { csp: { mode: "declared" } } },
    };
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: { csp: { connectDomains: ["https://api.openai.com"] } },
      },
      prev,
    );
    expect(next?.mcpProfile?.initialize?.clientInfo).toEqual({
      name: "claude-ai",
      version: "0.1.0",
    });
  });

  it("does NOT create a hostCapabilitiesOverride when sandbox is edited and hostCapabilities matches preset", () => {
    // Sandbox lives in its own top-level block; the override-diff
    // compares only static cap fields. Editing sandbox while leaving
    // hostCapabilities equal to the preset must not create a spurious
    // override.
    const prev = emptyHostConfigInputV2();
    const preset = resolveEffectiveHostCapabilities({
      hostStyle: prev.hostStyle,
      hostCapabilitiesOverride: undefined,
    }) as Record<string, unknown>;
    const next = applyJsonToDraft(
      {
        hostContext: {},
        hostCapabilities: preset,
        sandbox: { csp: { connectDomains: ["https://api.openai.com"] } },
      },
      prev,
    );
    expect(next?.hostCapabilitiesOverride).toBeUndefined();
    expect(
      next?.mcpProfile?.apps?.sandbox?.csp?.restrictTo?.connectDomains,
    ).toEqual(["https://api.openai.com"]);
  });

  it("strips a legacy `sandbox` key from hostCapabilities so it doesn't pollute the override diff", () => {
    // Older exports / hand-edits may still nest sandbox under
    // hostCapabilities. We ignore it there (it lives at top level now)
    // and must not let it flip the diff into 'override present'.
    const prev = emptyHostConfigInputV2();
    const preset = resolveEffectiveHostCapabilities({
      hostStyle: prev.hostStyle,
      hostCapabilitiesOverride: undefined,
    }) as Record<string, unknown>;
    const next = applyJsonToDraft(
      {
        hostContext: {},
        hostCapabilities: {
          ...preset,
          sandbox: { csp: { connectDomains: ["https://leaked.example"] } },
        },
      },
      prev,
    );
    expect(next?.hostCapabilitiesOverride).toBeUndefined();
  });

  it("round-trips csp.directiveOverrides through the renamed JSON shape", () => {
    // Inspector-only per-directive source-expression overrides on the
    // proxy iframe CSP. Surfaced under `csp.directiveOverrides`; stored
    // as `csp.cspDirectives` because that's the internal field name.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {
          csp: {
            directiveOverrides: {
              "script-src": ["'unsafe-eval'", "'wasm-unsafe-eval'"],
            },
          },
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.cspDirectives).toEqual({
      "script-src": ["'unsafe-eval'", "'wasm-unsafe-eval'"],
    });
  });

  it("clears csp.directiveOverrides when the csp block is present but the field is absent", () => {
    // Regression: with the unified-block "present-block-asserts-intent"
    // semantics, removing `directiveOverrides` from a still-present `csp`
    // block must clear it. Round-trip stability — if we silently
    // preserved prev's value, the next save would resurrect the field
    // the user deleted.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            cspDirectives: { "script-src": ["'unsafe-eval'"] },
          },
        },
      },
    };
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {
          csp: { connectDomains: ["https://api.openai.com"] },
        },
      },
      prev,
    );
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.cspDirectives).toBeUndefined();
    expect(
      next?.mcpProfile?.apps?.sandbox?.csp?.restrictTo?.connectDomains,
    ).toEqual(["https://api.openai.com"]);
  });

  it("round-trips iframeSandboxAttrs and permissionsPolicy through their renamed JSON keys", () => {
    // These two are inspector-only HTML iframe attribute knobs. Both
    // editable from the JSON now; both store under their legacy field
    // names internally.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {
          iframeSandboxAttrs: ["allow-forms", "allow-modals"],
          permissionsPolicy: { fullscreen: "*" },
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.sandbox?.sandboxAttrs).toEqual([
      "allow-forms",
      "allow-modals",
    ]);
    expect(next?.mcpProfile?.apps?.sandbox?.allowFeatures).toEqual({
      fullscreen: "*",
    });
  });

  it("round-trips EMPTY iframeSandboxAttrs/permissionsPolicy as the explicit strict-host model", () => {
    // Regression: serializing `sandboxAttrs: []` / `allowFeatures: {}`
    // used to be dropped from the JSON (only emitted when non-empty),
    // so a copy/paste import would lose the explicit "spec minimum"
    // model — the runtime treats the absent fields as the legacy
    // permissive default and silently re-grants
    // `local-network-access` / `midi` / popups / forms. Both directions
    // must preserve the empty container.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        sandbox: {
          iframeSandboxAttrs: [],
          permissionsPolicy: {},
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.sandbox?.sandboxAttrs).toEqual([]);
    expect(next?.mcpProfile?.apps?.sandbox?.allowFeatures).toEqual({});
  });

  it("preserves all sandbox state when JSON has no sandbox key at all", () => {
    // No-op save with rich internal state — everything (including
    // inspector-only knobs) survives because incomingPresent is false.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            cspDirectives: { "script-src": ["'unsafe-eval'"] },
            restrictTo: { connectDomains: ["https://api.openai.com"] },
          },
          sandboxAttrs: ["allow-forms"],
          allowFeatures: { fullscreen: "*" },
        },
      },
    };
    const next = applyJsonToDraft({ hostContext: {} }, prev);
    expect(next?.mcpProfile?.apps?.sandbox).toEqual(
      prev.mcpProfile.apps!.sandbox,
    );
  });
});

describe("AppsExtensionTab — mcpAppsOverrides JSON round-trip", () => {
  it("parses a sparse mcpAppsOverrides block into mcpProfile.apps.mcpAppsOverrides", () => {
    const next = applyJsonToDraft(
      {
        hostContext: {},
        mcpAppsOverrides: {
          serverResources: false,
          logging: false,
          availableDisplayModes: ["fullscreen"],
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.mcpAppsOverrides).toEqual({
      serverResources: false,
      logging: false,
      availableDisplayModes: ["fullscreen"],
    });
  });

  it("drops non-boolean / non-mode-string entries silently (soft validation)", () => {
    // Hand-typed JSON might be one rev behind the schema; tolerate stray
    // fields rather than crashing the editor on parse.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        mcpAppsOverrides: {
          serverResources: false,
          totallyBogus: "ignored",
          availableDisplayModes: ["inline", "weirdmode", "pip"],
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.mcpAppsOverrides).toEqual({
      serverResources: false,
      availableDisplayModes: ["inline", "pip"],
    });
  });

  it("collapses an entirely-invalid block to undefined (falls back to preset)", () => {
    // Nothing salvageable → no override persisted → the resolver uses
    // the host style preset on the next read.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        mcpAppsOverrides: {
          totallyBogus: "ignored",
          availableDisplayModes: ["weirdmode"],
        },
      },
      emptyHostConfigInputV2(),
    );
    expect(next?.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
  });

  it("clears mcpAppsOverrides when the key is absent from the parsed JSON", () => {
    // User edits the JSON to remove the entire mcpAppsOverrides block →
    // the override clears so the resolver falls back to the preset.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        mcpAppsOverrides: { serverResources: false },
      },
    };
    const next = applyJsonToDraft({ hostContext: {} }, prev);
    expect(next?.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
  });

  it("serialize/parse round-trip with mcpAppsOverrides does NOT create a stale legacy hostCapabilitiesOverride", () => {
    // Regression: the diff target for `hostCapabilities` was the
    // preset alone, so any matrix override that produced a non-preset
    // wire shape (e.g. Claude with serverResources turned off) would
    // round-trip into a stale legacy `hostCapabilitiesOverride` —
    // every editor save would silently create one beside the matrix.
    // The fix diffs against the matrix-resolved shape instead, so a
    // faithful serialization round-trips with no legacy override.
    const prev = emptyHostConfigInputV2({ hostStyle: "claude" });
    prev.mcpProfile = {
      profileVersion: 1,
      apps: { mcpAppsOverrides: { serverResources: false, logging: false } },
    };
    // What the editor would actually show on serialize: the matrix-
    // derived effective hostCapabilities + the matrix override.
    const effectiveHostCapabilities = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
      profile: prev.mcpProfile,
    });
    const next = applyJsonToDraft(
      {
        hostContext: {},
        hostCapabilities: effectiveHostCapabilities,
        mcpAppsOverrides: { serverResources: false, logging: false },
      },
      prev,
    );
    // Matrix preserved; legacy override NOT created.
    expect(next?.mcpProfile?.apps?.mcpAppsOverrides).toEqual({
      serverResources: false,
      logging: false,
    });
    expect(next?.hostCapabilitiesOverride).toBeUndefined();
  });

  it("removing mcpAppsOverrides from JSON actually reverts the resolver to the host style preset", () => {
    // Regression: when the user removes `mcpAppsOverrides`, the
    // resolver should fall back to the preset. The pre-fix parser
    // would create a stale legacy `hostCapabilitiesOverride` from
    // the serialized matrix-derived `hostCapabilities`, keeping the
    // same capability behavior alive even though the matrix was
    // cleared.
    const prev = emptyHostConfigInputV2({ hostStyle: "claude" });
    prev.mcpProfile = {
      profileVersion: 1,
      apps: { mcpAppsOverrides: { serverResources: false, logging: false } },
    };
    // User edits the JSON: removes `mcpAppsOverrides`, but the
    // `hostCapabilities` field in the JSON might still be the
    // pre-removal matrix-derived shape (the editor serializer would
    // refresh it on next render, but parse needs to handle this
    // intermediate state correctly).
    const stalehostCapabilities = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
      profile: prev.mcpProfile,
    });
    const next = applyJsonToDraft(
      {
        hostContext: {},
        hostCapabilities: stalehostCapabilities,
        // mcpAppsOverrides removed
      },
      prev,
    );
    // Matrix cleared. The stale hostCapabilities serialization
    // becomes a legacy override (the matrix can no longer produce
    // it, so the user must have meant the literal value) — but
    // that's a separate explicit choice the user is making by
    // leaving the JSON in that state.
    expect(next?.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
    // The KEY regression test: if the user removes BOTH
    // `mcpAppsOverrides` AND clears `hostCapabilities` back to the
    // preset shape, the resolver fully reverts.
    const presetEffective = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
    });
    const fullyCleared = applyJsonToDraft(
      {
        hostContext: {},
        hostCapabilities: presetEffective,
      },
      prev,
    );
    expect(fullyCleared?.mcpProfile?.apps?.mcpAppsOverrides).toBeUndefined();
    expect(fullyCleared?.hostCapabilitiesOverride).toBeUndefined();
    // Confirm the resolver advertises the bare preset.
    const advertised = resolveEffectiveHostCapabilities({
      hostStyle: fullyCleared!.hostStyle,
      profile: fullyCleared!.mcpProfile,
      hostCapabilitiesOverride: fullyCleared!.hostCapabilitiesOverride,
    });
    expect(advertised).toEqual(presetEffective);
  });

  it("preserves siblings (compatRuntime, sandbox, uiInitialize) when only mcpAppsOverrides changes", () => {
    // Sibling fields under `mcpProfile.apps` round-trip through their own
    // serializers; touching mcpAppsOverrides must not collateral-damage
    // the other apps subsections.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          permissions: { mode: "deny-all" },
        },
        compatRuntime: { openaiApps: false },
        uiInitialize: { hostInfo: { name: "fakehost", version: "1.0" } },
      },
    };
    const next = applyJsonToDraft(
      {
        hostContext: {},
        compatRuntime: { openaiApps: false },
        uiInitialize: { hostInfo: { name: "fakehost", version: "1.0" } },
        mcpAppsOverrides: { logging: false },
      },
      prev,
    );
    expect(next?.mcpProfile?.apps?.mcpAppsOverrides).toEqual({
      logging: false,
    });
    expect(next?.mcpProfile?.apps?.compatRuntime?.openaiApps).toBe(false);
    expect(next?.mcpProfile?.apps?.uiInitialize?.hostInfo).toEqual({
      name: "fakehost",
      version: "1.0",
    });
  });
});

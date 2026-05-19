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

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
    // Sandbox lives at mcpProfile.apps.sandbox; the matrix surfaces it as
    // its own section for visibility, but clicking opens the Apps
    // Extension tab so users edit the spec-shaped JSON.
    expect(focusTabForNodeId(SANDBOX_HUB_NODE_ID)).toEqual({
      tab: "apps",
      selectedServerId: null,
    });
  });

  it("routes every sandbox leaf node id to the Apps Extension tab", () => {
    for (const sub of ["mode", "restrictTo", "deny", "permissions"] as const) {
      expect(focusTabForNodeId(sandboxConfigLeafNodeId(sub))).toEqual({
        tab: "apps",
        selectedServerId: null,
      });
    }
  });

  it("still routes apps-cap clicks to apps (no startsWith() bleed)", () => {
    expect(focusTabForNodeId("apps-cap:openLinks")?.tab).toBe("apps");
  });
});

describe("AppsExtensionTab — spec-shaped sandbox round-trip", () => {
  it("writes spec-shaped hostCapabilities.sandbox.csp into storage as restrictTo", () => {
    // The user typed spec-shaped JSON: domain arrays under csp,
    // presence-flags under permissions. Internally we store this as
    // `restrictTo` + `allow` because we layer additional inspector knobs
    // (mode/deny) on top — but those aren't in the JSON.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        hostCapabilities: {
          sandbox: {
            csp: {
              connectDomains: ["https://api.openai.com"],
              resourceDomains: ["https://cdn.jsdelivr.net"],
            },
            permissions: { clipboardWrite: {}, microphone: {} },
          },
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

  it("preserves inspector-only mode/deny on edit (not surfaced in JSON, can't be wiped from it)", () => {
    // Regression: mode + deny are inspector knobs (not in SEP-1865). The
    // JSON view shows only spec primitives. If editing the JSON dropped
    // mode/deny, a user who set `mode: "relaxed"` from elsewhere would
    // silently lose it the next time they saved this tab.
    const prev = emptyHostConfigInputV2();
    prev.mcpProfile = {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: {
            mode: "relaxed",
            restrictTo: { connectDomains: ["https://api.openai.com"] },
            deny: { connectDomains: ["https://evil.com"] },
          },
          permissions: { mode: "custom", deny: ["camera"] },
        },
      },
    };
    // User edits hostCapabilities.sandbox in JSON, swapping the allowed
    // connect domain. Nothing about mode/deny in the JSON.
    const next = applyJsonToDraft(
      {
        hostContext: {},
        hostCapabilities: {
          sandbox: {
            csp: { connectDomains: ["https://api.anthropic.com"] },
          },
        },
      },
      prev,
    );
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.mode).toBe("relaxed");
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.deny).toEqual({
      connectDomains: ["https://evil.com"],
    });
    expect(next?.mcpProfile?.apps?.sandbox?.csp?.restrictTo).toEqual({
      connectDomains: ["https://api.anthropic.com"],
    });
    expect(next?.mcpProfile?.apps?.sandbox?.permissions?.mode).toBe("custom");
    expect(next?.mcpProfile?.apps?.sandbox?.permissions?.deny).toEqual([
      "camera",
    ]);
  });

  it("treats absent hostCapabilities.sandbox as 'no change' (preserves prev sandbox verbatim)", () => {
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

  it("treats empty hostCapabilities.sandbox as 'clear restrictTo + allow' but keeps mode/deny", () => {
    // The user explicitly emptied the spec-shape (e.g. they cleared the
    // arrays from the JSON). That should drop restrictTo/allow but keep
    // mode/deny so the user doesn't lose the inspector-side state.
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
        hostCapabilities: { sandbox: {} },
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
        hostCapabilities: {
          sandbox: {
            permissions: { clipboardWrite: {} },
            // microphone absent → not granted
          },
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
        hostCapabilities: {
          sandbox: { csp: { connectDomains: ["https://api.openai.com"] } },
        },
      },
      prev,
    );
    expect(next?.mcpProfile?.initialize?.clientInfo).toEqual({
      name: "claude-ai",
      version: "0.1.0",
    });
  });

  it("does NOT create a hostCapabilitiesOverride when JSON matches preset + adds sandbox", () => {
    // The override-diff compares static caps only. Adding sandbox to the
    // JSON while leaving the rest of hostCapabilities equal to the
    // preset must not create a spurious override — sandbox is policy
    // (stored separately at mcpProfile.apps.sandbox), not a vendor cap.
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
          sandbox: { csp: { connectDomains: ["https://api.openai.com"] } },
        },
      },
      prev,
    );
    expect(next?.hostCapabilitiesOverride).toBeUndefined();
    // sandbox still landed in policy storage
    expect(
      next?.mcpProfile?.apps?.sandbox?.csp?.restrictTo?.connectDomains,
    ).toEqual(["https://api.openai.com"]);
  });
});

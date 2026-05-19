/**
 * Tests for {@link SandboxDebugPanel}.
 *
 * Covers the contract pieces that are tricky to verify by eyeballing the
 * component:
 *
 *   - Lifecycle strip is hidden entirely when no events fired (no synthetic
 *     pending placeholders — "render only actual data" memory).
 *   - Resolved-policy grid only renders when `applied` is published
 *     (OpenAI-Apps v1 path keeps it hidden).
 *   - "Permissive" badge surfaces iff `applied.permissive` is true.
 *   - Widget-declared collapsible only lists fields the widget actually
 *     declared — no "Not declared" filler rows.
 *   - Suggested-fix snippet keyspaces match the active protocol
 *     (mcp-apps → camelCase, openai-apps → snake_case).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SandboxDebugPanel } from "../sandbox-debug-panel";
import type {
  CspViolation,
  WidgetLifecycleEvent,
  WidgetSandboxApplied,
} from "@/stores/widget-debug-store";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: { themeMode: "light" | "dark" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/contexts/chatbox-client-style-context", () => ({
  useChatboxHostTheme: () => null,
}));

const baseSandboxInfo = {
  mode: "permissive" as const,
  connectDomains: [],
  resourceDomains: [],
  violations: [] as CspViolation[],
};

beforeEach(() => {
  // Tooltip / clipboard noise — keep test output clean.
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});

describe("SandboxDebugPanel — lifecycle strip", () => {
  it("hides the strip when no events fired (no fabricated pending dots)", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle: [] }}
        protocol="mcp-apps"
      />,
    );
    // No stage labels render — strip is hidden entirely.
    expect(screen.queryByText("Proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("Initialized")).not.toBeInTheDocument();
  });

  it("always renders the same 4 stages (Proxy → Content → Bridge → Initialized)", () => {
    // Even with sparse events, the strip is a fixed-width progress
    // indicator. Stages without events render in the muted "absent"
    // tint so the eye locks onto where things stopped.
    const lifecycle: WidgetLifecycleEvent[] = [
      { kind: "sandbox-proxy-ready", status: "ok", timestamp: 1 },
      { kind: "widget-content-ready", status: "ok", timestamp: 2 },
      { kind: "bridge-connect-error", status: "error", timestamp: 3, message: "timeout" },
    ];
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.getByText("Proxy")).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.getByText("Bridge")).toBeInTheDocument();
    expect(screen.getByText("Initialized")).toBeInTheDocument();
  });

  it("collapses repeated lifecycle events into a single stage (no retry chip)", () => {
    // The renderer can re-trigger the entire sequence on re-render; the
    // strip must read as a 4-stage progress, not an unbounded event log.
    // The retry count is intentionally NOT surfaced as a visible chip
    // (it was reading as "something is wrong" when in practice it just
    // means React re-rendered the surface) — it stays in the hover title
    // only.
    const lifecycle: WidgetLifecycleEvent[] = [];
    for (let i = 0; i < 3; i++) {
      lifecycle.push({
        kind: "widget-content-requested",
        status: "pending",
        timestamp: i * 10,
      });
      lifecycle.push({
        kind: "widget-content-ready",
        status: "ok",
        timestamp: i * 10 + 1,
      });
    }
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.getAllByText("Content")).toHaveLength(1);
    expect(screen.queryByText(/×\d/)).not.toBeInTheDocument();
  });
});

describe("SandboxDebugPanel — resolved-policy grid", () => {
  const applied: WidgetSandboxApplied = {
    permissive: false,
    hostPolicyApplied: true,
    sandboxAttrs: ["allow-forms", "allow-popups"],
    allowFeatures: { clipboardWrite: "*" },
    cspDirectives: { "script-src": ["'unsafe-eval'"] },
    permissions: { camera: {}, microphone: {} },
  };

  it("is hidden when no applied payload was published (OpenAI Apps v1)", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle: [] }}
        protocol="openai-apps"
      />,
    );
    expect(
      screen.queryByText(/Sandbox proxy iframe/i),
    ).not.toBeInTheDocument();
  });

  it("renders the Sandbox proxy iframe card when applied is published", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle: [], applied }}
        protocol="mcp-apps"
      />,
    );
    // The full matrix card heading is rendered.
    expect(screen.getByText("Sandbox proxy iframe")).toBeInTheDocument();
    // The grid surfaces the granted permission names as the Permissions
    // row's summary value (matrix semantics).
    expect(screen.getByText(/camera, microphone/i)).toBeInTheDocument();
    // And the sandboxAttrs row's summary should show the first two attrs.
    expect(screen.getByText(/allow-forms, allow-popups/i)).toBeInTheDocument();
  });

  it("hides the View iframe sub-card when hostInfo is null (no fabricated empty)", () => {
    // When the host hasn't customized uiInitialize.hostInfo, rendering a
    // lone "uiInitialize" line adds noise without telling the reader
    // anything. The runtime panel doesn't wire up a click handler either,
    // so there's no editing affordance to preserve.
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle: [], applied }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.queryByText("View iframe")).not.toBeInTheDocument();
    expect(screen.queryByText("uiInitialize")).not.toBeInTheDocument();
  });

  it("shows the View iframe sub-card when hostInfo is published", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{
          ...baseSandboxInfo,
          lifecycle: [],
          applied,
          hostInfo: { name: "mcpjam-inspector", version: "2.4.12" },
        }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.getByText("View iframe")).toBeInTheDocument();
    expect(screen.getByText("mcpjam-inspector")).toBeInTheDocument();
    expect(screen.getByText("2.4.12")).toBeInTheDocument();
  });

  it("shows the permissive badge iff applied.permissive is true", () => {
    const { rerender } = render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle: [], applied }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.queryByText("permissive")).not.toBeInTheDocument();

    rerender(
      <SandboxDebugPanel
        sandboxInfo={{
          ...baseSandboxInfo,
          lifecycle: [],
          applied: { ...applied, permissive: true },
        }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.getByText("permissive")).toBeInTheDocument();
  });
});

describe("SandboxDebugPanel — widget-declared collapsible", () => {
  it("renders only fields the widget actually declared (no Not declared filler)", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{
          ...baseSandboxInfo,
          lifecycle: [],
          widgetDeclared: {
            connectDomains: ["https://api.example.com"],
            // resource/frame/baseUri intentionally omitted
          },
        }}
        protocol="mcp-apps"
      />,
    );
    // The summary chevron is in the DOM
    expect(screen.getByText("Widget declared")).toBeInTheDocument();
    // The collapsible body content is rendered (details is open in test env)
    expect(screen.getByText("connect_domains")).toBeInTheDocument();
    expect(screen.getByText("https://api.example.com")).toBeInTheDocument();
    // Crucially, no "Not declared" filler text appears anywhere
    expect(screen.queryByText(/Not declared/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not enforced/i)).not.toBeInTheDocument();
  });

  it("hides the collapsible when the widget declared nothing", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle: [], widgetDeclared: {} }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.queryByText("Widget declared")).not.toBeInTheDocument();
  });
});

describe("SandboxDebugPanel — suggested fix protocol switching", () => {
  const violationOnExample: CspViolation = {
    directive: "connect-src",
    blockedUri: "https://api.example.com/data",
    effectiveDirective: "connect-src",
    originalPolicy: "",
    disposition: "enforce",
    timestamp: 0,
  };

  it("emits camelCase key for mcp-apps", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{
          ...baseSandboxInfo,
          violations: [violationOnExample],
          lifecycle: [],
        }}
        protocol="mcp-apps"
      />,
    );
    // The <pre> code block in the suggested-fix details is in the DOM
    expect(screen.getByText(/"connectDomains"/)).toBeInTheDocument();
  });

  it("emits snake_case key for openai-apps", () => {
    render(
      <SandboxDebugPanel
        sandboxInfo={{
          ...baseSandboxInfo,
          violations: [violationOnExample],
          lifecycle: [],
        }}
        protocol="openai-apps"
      />,
    );
    expect(screen.getByText(/"connect_domains"/)).toBeInTheDocument();
  });
});

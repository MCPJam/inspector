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
    expect(screen.queryByText(/proxy/)).not.toBeInTheDocument();
    expect(screen.queryByText(/initialized/)).not.toBeInTheDocument();
  });

  it("renders one labeled dot per event the renderer emitted", () => {
    const lifecycle: WidgetLifecycleEvent[] = [
      { kind: "sandbox-proxy-ready", status: "ok", timestamp: 1 },
      { kind: "widget-content-ready", status: "ok", timestamp: 2 },
      { kind: "bridge-connect-error", status: "error", timestamp: 3 },
    ];
    render(
      <SandboxDebugPanel
        sandboxInfo={{ ...baseSandboxInfo, lifecycle }}
        protocol="mcp-apps"
      />,
    );
    expect(screen.getByText("proxy")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByText("bridge err")).toBeInTheDocument();
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
    // The full matrix card heading is rendered (not the old plain
    // "Resolved sandbox policy" label).
    expect(screen.getByText("Sandbox proxy iframe")).toBeInTheDocument();
    // The nested View iframe sub-card is also rendered.
    expect(screen.getByText("View iframe")).toBeInTheDocument();
    // The grid surfaces the granted permission names as the Permissions
    // row's summary value (matrix semantics).
    expect(screen.getByText(/camera, microphone/i)).toBeInTheDocument();
    // And the sandboxAttrs row's summary should show the first two attrs.
    expect(screen.getByText(/allow-forms, allow-popups/i)).toBeInTheDocument();
  });

  it("threads hostInfo into the View iframe sub-card", () => {
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

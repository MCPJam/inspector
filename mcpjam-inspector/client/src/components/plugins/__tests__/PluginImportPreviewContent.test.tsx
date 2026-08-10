/**
 * Import preview (Phase 7): skipped components are the one place the plugin
 * surfaces defer minimal-UI to loudness — a partial install a user never saw
 * coming reads as a runtime bug later. The block must be visible WITHOUT any
 * expander interaction, and a preview without skips (including one from a
 * backend that predates the field) must render nothing for them at all.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PluginImportPreview } from "@/lib/plugins/plugin-api-types";
import { PluginImportPreviewContent } from "../PluginImportPreviewContent";

function makePreview(
  overrides: Partial<PluginImportPreview> = {},
): PluginImportPreview {
  return {
    identity: { name: "demo", displayName: "Demo" },
    bundleHash: "aa11bb22cc33dd44",
    manifestHash: "ff00",
    counts: {
      skills: 0,
      servers: 1,
      apps: 0,
      assets: 0,
      unsupported: 0,
      warnings: 0,
    },
    skills: [],
    servers: [{ key: "api", transport: "http" }],
    apps: [],
    assets: [],
    setupRequirements: [],
    unsupported: [],
    warnings: [],
    ...overrides,
  };
}

describe("PluginImportPreviewContent — skipped components", () => {
  it("surfaces every skip loudly before commit, with name and reason", () => {
    render(
      <PluginImportPreviewContent
        preview={makePreview({
          skippedComponents: [
            {
              kind: "server",
              key: "legacy",
              reason: 'unknown transport "websocket"',
            },
            { kind: "skill", key: "triage", reason: "missing SKILL.md" },
          ],
        })}
      />,
    );
    // Visible immediately — no expander click needed.
    const block = screen.getByTestId("plugin-preview-skipped");
    expect(block.textContent).toContain("2 components will not be installed");
    expect(block.textContent).toContain("MCP server");
    expect(block.textContent).toContain("legacy");
    expect(block.textContent).toContain('unknown transport "websocket"');
    expect(block.textContent).toContain("Skill");
    expect(block.textContent).toContain("triage");
    expect(block.textContent).toContain("missing SKILL.md");
  });

  it("echoes an unknown skip kind verbatim instead of dropping the row", () => {
    render(
      <PluginImportPreviewContent
        preview={makePreview({
          skippedComponents: [
            { kind: "future-kind", key: "x", reason: "because" },
          ],
        })}
      />,
    );
    const block = screen.getByTestId("plugin-preview-skipped");
    expect(block.textContent).toContain("future-kind");
    expect(block.textContent).toContain("because");
  });

  it("renders nothing when the field is absent (older backend) or empty", () => {
    const { unmount } = render(
      <PluginImportPreviewContent preview={makePreview()} />,
    );
    expect(screen.queryByTestId("plugin-preview-skipped")).toBeNull();
    unmount();

    render(
      <PluginImportPreviewContent
        preview={makePreview({ skippedComponents: [] })}
      />,
    );
    expect(screen.queryByTestId("plugin-preview-skipped")).toBeNull();
  });
});

describe("PluginImportPreviewContent — server transport wording", () => {
  /** The per-server detail lives behind the "MCP servers" expander. */
  function openServersSection() {
    fireEvent.click(screen.getByRole("button", { name: /MCP servers/ }));
  }

  it("prefers the declared http variant over the transport family", () => {
    render(
      <PluginImportPreviewContent
        preview={makePreview({
          servers: [{ key: "api", transport: "http", httpVariant: "sse" }],
        })}
      />,
    );
    openServersSection();
    expect(screen.getByText("sse")).toBeTruthy();
    expect(screen.queryByText("http")).toBeNull();
  });

  it("falls back to the transport family when no variant is forwarded", () => {
    render(<PluginImportPreviewContent preview={makePreview()} />);
    openServersSection();
    expect(screen.getByText("http")).toBeTruthy();
  });
});

describe("PluginImportPreviewContent — dotted plugin names", () => {
  it("renders a dotted Agent Plugins name verbatim", () => {
    render(
      <PluginImportPreviewContent
        preview={makePreview({
          identity: { name: "com.acme.tools" },
        })}
      />,
    );
    expect(screen.getByText("com.acme.tools")).toBeTruthy();
  });
});

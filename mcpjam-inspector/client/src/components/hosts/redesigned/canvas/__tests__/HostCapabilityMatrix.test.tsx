import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  HOST_TEMPLATES,
  seedFromHostTemplate,
} from "@mcpjam/sdk/host-config/templates";
import type { HostThemeMode } from "@/lib/client-styles";
import { getHostLogoSrc, UNKNOWN_HOST_LOGO } from "@/lib/host-ui-metadata";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import { HOST_MATRIX_NODE_ID, type HostMatrixNodeData } from "../../types";
import { buildRedesignedHostCanvas } from "../canvasBuilder";
import { HostMatrixCard } from "../HostCapabilityMatrix";

function renderCard(
  templateId: (typeof HOST_TEMPLATES)[number]["id"],
  hostName: string,
  themeMode: HostThemeMode,
  hostStyle?: string,
) {
  const draft = seedFromHostTemplate(templateId, { theme: themeMode });
  const viewModel = buildRedesignedHostCanvas(
    {
      hostName,
      draft: hostStyle ? { ...draft, hostStyle } : draft,
      savedSnapshotId: "snap",
      isDirty: false,
      projectServers: [],
    },
    [],
  );
  const data = viewModel.nodes.find((n) => n.id === HOST_MATRIX_NODE_ID)
    ?.data as HostMatrixNodeData;
  return render(
    <HostMatrixCard
      {...data}
      themeMode={themeMode}
      selectedNodeId={null}
      onSelectNode={() => {}}
    />,
  );
}

function glyphSrc(container: HTMLElement): string | null {
  return container.querySelector(".hp-glyph-img")?.getAttribute("src") ?? null;
}

describe("HostMatrixCard logo", () => {
  // A new template gets its canvas logo from its host style; there is no
  // second keyword map to update.
  it.each(
    HOST_TEMPLATES.flatMap((t) =>
      (["light", "dark"] as const).map((theme) => [t.id, t.label, theme]),
    ),
  )("%s (%s, %s) shows its host style's logo", (id, label, theme) => {
    const { container } = renderCard(id, label, theme);
    const { hostStyle } = seedFromHostTemplate(id, { theme });
    expect(glyphSrc(container)).toBe(
      getScenarioHostLogo(hostStyle, undefined, theme),
    );
  });

  it("keeps the style's logo when the host is renamed", () => {
    const { container } = renderCard("chatgpt", "Cursor staging", "light");
    expect(glyphSrc(container)).toBe(getScenarioHostLogo("chatgpt"));
  });

  // Hosts saved before their style was retired, or with a custom style this
  // client does not register, fall back to the hint table in host-logo.ts.
  describe("with a host style the client does not register", () => {
    it("takes the logo from a recognised host name", () => {
      const { container } = renderCard(
        "claude",
        "Cursor (staging)",
        "light",
        "retired-style",
      );
      expect(glyphSrc(container)).toBe(getHostLogoSrc("cursor", "light"));
      expect(glyphSrc(container)).not.toBe(UNKNOWN_HOST_LOGO);
    });

    // The card used to match the clientInfo name as well. It no longer reads
    // it, so the Claude template's "claude-ai" does not pick Claude's logo.
    it("shows the generic MCP mark when only the clientInfo name is recognised", () => {
      const { container } = renderCard(
        "claude",
        "Team bot",
        "light",
        "retired-style",
      );
      expect(container.textContent).toContain("claude-ai");
      expect(glyphSrc(container)).toBe(UNKNOWN_HOST_LOGO);
    });
  });
});

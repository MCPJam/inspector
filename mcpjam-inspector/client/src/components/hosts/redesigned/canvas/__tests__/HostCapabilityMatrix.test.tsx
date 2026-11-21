import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  HOST_TEMPLATES,
  seedFromHostTemplate,
} from "@mcpjam/sdk/host-config/templates";
import type { HostThemeMode } from "@/lib/client-styles";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import { HOST_MATRIX_NODE_ID, type HostMatrixNodeData } from "../../types";
import { buildRedesignedHostCanvas } from "../canvasBuilder";
import { HostMatrixCard } from "../HostCapabilityMatrix";

function renderCard(
  templateId: (typeof HOST_TEMPLATES)[number]["id"],
  hostName: string,
  themeMode: HostThemeMode,
) {
  const viewModel = buildRedesignedHostCanvas(
    {
      hostName,
      draft: seedFromHostTemplate(templateId, { theme: themeMode }),
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
});

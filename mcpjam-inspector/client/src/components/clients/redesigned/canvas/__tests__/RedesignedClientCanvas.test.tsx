import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { HOST_MATRIX_NODE_ID, SERVERS_HUB_NODE_ID } from "../../types";
import { RedesignedClientCanvas } from "../RedesignedClientCanvas";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

function renderCanvas(opts: {
  draft?: ReturnType<typeof emptyHostConfigInputV2>;
  hostName?: string;
  projectServers?: Array<{
    id: string;
    name: string;
    url?: string;
  }>;
}) {
  const viewModel = buildRedesignedHostCanvas(
    {
      hostName: opts.hostName ?? "Test host",
      draft: opts.draft ?? emptyHostConfigInputV2(),
      savedSnapshotId: "snap",
      isDirty: false,
      projectServers: opts.projectServers ?? [],
    },
    [],
  );
  return render(
    <ReactFlowProvider>
      <div style={{ width: 900, height: 700 }}>
        <RedesignedClientCanvas
          viewModel={viewModel}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          onAddServer={() => {}}
        />
      </div>
    </ReactFlowProvider>,
  );
}

describe("RedesignedClientCanvas", () => {
  it("renders the host matrix node with the display name", () => {
    const { container } = renderCanvas({ hostName: "Claude" });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    );
    expect(node).not.toBeNull();
    expect(
      within(node as HTMLElement).getByText("Claude"),
    ).toBeInTheDocument();
  });

  it("shows timeout on the identity subtitle beside client metadata", () => {
    const { container } = renderCanvas({});
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const sub = (node as HTMLElement).querySelector(".hp-host-sub");
    expect(sub).not.toBeNull();
    expect(sub!.textContent).toMatch(/Timeout/);
    expect(sub!.textContent).toMatch(/10s/);
    expect((node as HTMLElement).querySelector(".hp-agents")).toBeNull();
  });

  it("renders advertised client capabilities and the apps extension banner", () => {
    const { container } = renderCanvas({});
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const scope = within(node as HTMLElement);
    expect(scope.getByText("Client capabilities")).toBeInTheDocument();
    const caps = node!.querySelector(".hp-caps");
    expect(caps).not.toBeNull();
    const capScope = within(caps as HTMLElement);
    expect(capScope.getByText("extensions")).toBeInTheDocument();
    expect(capScope.queryByText("roots")).toBeNull();
    expect(capScope.queryByText("sampling")).toBeNull();
    expect(scope.getByText("View iframe")).toBeInTheDocument();
    expect(scope.getByText("openLinks")).toBeInTheDocument();
    expect(node!.querySelector(".hp-policy-tag")).toBeNull();
    expect(node!.querySelector(".hp-sandbox-sub")).toBeNull();
  });

  it("adds a client capability chip when that cap is enabled on the host", () => {
    const base = emptyHostConfigInputV2();
    const { container } = renderCanvas({
      draft: emptyHostConfigInputV2({
        clientCapabilities: {
          ...base.clientCapabilities,
          roots: { listChanged: true },
        },
      }),
    });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const caps = node!.querySelector(".hp-caps");
    expect(caps).not.toBeNull();
    expect(within(caps as HTMLElement).getByText("roots")).toBeInTheDocument();
  });

  it("does not show required/optional chips on canvas server cards", () => {
    const { container } = renderCanvas({
      projectServers: [
        { id: "s1", name: "bench", url: "https://example.com" },
      ],
    });
    const card = container.querySelector(
      `.react-flow__node[data-id="server-card:s1"]`,
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(within(card!).queryByText(/^required$/i)).toBeNull();
    expect(within(card!).queryByText(/^optional$/i)).toBeNull();
  });

  it("styles the servers hub with neutral card chrome like server rows", () => {
    const { container } = renderCanvas({});
    const hub = container.querySelector(
      `.react-flow__node[data-id="${SERVERS_HUB_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(hub).not.toBeNull();
    const shell = hub!.firstElementChild as HTMLElement;
    expect(shell.className).toMatch(/\bborder-border\/70\b/);
    expect(shell.className).toMatch(/\bbg-card\/95\b/);
    expect(shell.className).not.toMatch(/diagram-server/);
  });

  it("does not duplicate extensions in the matrix footer", () => {
    const { container } = renderCanvas({});
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const scope = within(node as HTMLElement);
    expect(scope.queryByText(/^Extensions ·/)).toBeNull();
    const footer = (node as HTMLElement).querySelector(".hp-footer");
    expect(footer).not.toBeNull();
    expect(footer!.querySelector(".hp-ctx-btn")).not.toBeNull();
  });

  it("strikes through apps caps the resolved blob omits", () => {
    const draft = emptyHostConfigInputV2({
      hostCapabilitiesOverride: { openLinks: {} },
    });
    const { container } = renderCanvas({ draft });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    // Off caps in the View frame carry the `hp-view-cap--off` class which
    // applies a dashed border + strike-through via CSS. Asserting the
    // semantic class beats asserting a Tailwind utility name that the
    // redesign no longer uses.
    expect(
      (node as HTMLElement).querySelector(".hp-view-cap--off"),
    ).not.toBeNull();
  });
});

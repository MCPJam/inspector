import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { DEFAULT_HOST_STYLE } from "@/lib/client-styles";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import { HostCanvas } from "../HostCanvas";
import {
  HOST_BUILDER_HOST_NODE_ID,
  type HostBuilderNodeData,
  type HostBuilderViewModel,
} from "../host-builder-types";

function renderCanvas(hostData: Partial<HostBuilderNodeData>) {
  const viewModel: HostBuilderViewModel = {
    title: "Test host",
    nodes: [
      {
        id: HOST_BUILDER_HOST_NODE_ID,
        type: "hostNode",
        position: { x: 0, y: 0 },
        data: {
          kind: "host",
          title: "Host",
          subtitle: "Test host",
          chips: [],
          state: "ready",
          ...hostData,
        },
      },
    ],
    edges: [],
  };
  return render(
    <ReactFlowProvider>
      <div style={{ width: 900, height: 700 }}>
        <HostCanvas
          viewModel={viewModel}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          onAddServer={() => {}}
        />
      </div>
    </ReactFlowProvider>
  );
}

function hostLogoSrc(container: HTMLElement): string | null {
  const img = container.querySelector(
    `.react-flow__node[data-id="${HOST_BUILDER_HOST_NODE_ID}"] img`
  );
  expect(img).not.toBeNull();
  return img!.getAttribute("src");
}

describe("HostCanvas host style logo", () => {
  const defaultLogo = getScenarioHostLogo(DEFAULT_HOST_STYLE.id);

  it("falls back to the default host style when hostStyle is omitted", () => {
    const { container } = renderCanvas({});
    expect(hostLogoSrc(container)).toBe(defaultLogo);
  });

  // `hostStyle` is typed `HostStyleId` (a plain string), so an empty string is
  // reachable without a cast; the registry treats it as an unknown id.
  it("falls back to the default host style when hostStyle is empty", () => {
    const { container } = renderCanvas({ hostStyle: "" });
    expect(hostLogoSrc(container)).toBe(defaultLogo);
  });

  it("renders the logo of the requested host style", () => {
    const chatgptLogo = getScenarioHostLogo("chatgpt");
    expect(chatgptLogo).not.toBe(defaultLogo);

    const { container } = renderCanvas({ hostStyle: "chatgpt" });
    expect(hostLogoSrc(container)).toBe(chatgptLogo);
  });
});

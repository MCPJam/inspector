import { describe, it, expect } from "vitest";
import { buildArchNodesAndEdges } from "../archDiagramBuilder";
import {
  ARCH_ASSET_CODE_WIDTH,
  ARCH_ASSET_CODE_HEIGHT,
} from "../constants";

describe("buildArchNodesAndEdges", () => {
  it("maps asset defs to archAsset nodes with dimensions and code payload", () => {
    const { nodes } = buildArchNodesAndEdges({
      nodes: [
        {
          id: "a1",
          label: "Snippet",
          type: "asset",
          assetType: "code",
          color: "#000",
          code: "console.log(1)",
          position: { x: 10, y: 20 },
        },
      ],
      edges: [],
    });

    expect(nodes).toHaveLength(1);
    const n = nodes[0] as {
      type: string;
      data: Record<string, unknown>;
      style?: { width: number; height: number };
    };
    expect(n.type).toBe("archAsset");
    expect(n.data.assetType).toBe("code");
    expect(n.data.code).toBe("console.log(1)");
    expect(n.data.width).toBe(ARCH_ASSET_CODE_WIDTH);
    expect(n.data.height).toBe(ARCH_ASSET_CODE_HEIGHT);
    expect(n.style?.width).toBe(ARCH_ASSET_CODE_WIDTH);
    expect(n.style?.height).toBe(ARCH_ASSET_CODE_HEIGHT);
  });

  it("respects explicit width and height on asset defs", () => {
    const { nodes } = buildArchNodesAndEdges({
      nodes: [
        {
          id: "img1",
          label: "Shot",
          type: "asset",
          assetType: "image",
          color: "#999",
          imageSrc: "/x.png",
          width: 100,
          height: 50,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });
    const n = nodes[0] as { data: { width: number; height: number } };
    expect(n.data.width).toBe(100);
    expect(n.data.height).toBe(50);
  });
});

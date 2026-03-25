import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { ArchBlockNode } from "../ArchBlockNode";
import type { ArchBlockNodeData } from "../types";

const baseData: ArchBlockNodeData = {
  label: "Widget",
  subtitle: "dashboard.js",
  color: "#10b981",
  status: "neutral",
  imageSrc: "/react-icon.png",
  imageAlt: "React component",
};

function renderArchBlock(
  data: ArchBlockNodeData,
  width?: number,
  height?: number,
) {
  const merged: ArchBlockNodeData = { ...data, width, height };
  const props = {
    id: "n1",
    type: "archBlock",
    position: { x: 0, y: 0 },
    data: merged,
  } as unknown as NodeProps<Node<ArchBlockNodeData>>;

  return render(
    <ReactFlowProvider>
      <ArchBlockNode {...props} />
    </ReactFlowProvider>,
  );
}

describe("ArchBlockNode", () => {
  it("uses compact image when wide but below hero min height (MCP Apps widget)", () => {
    renderArchBlock(baseData, 200, 80);
    const img = screen.getByRole("img", { name: "React component" });
    expect(img.className).toContain("h-5");
    expect(img.className).toContain("w-5");
    expect(img.className).toContain("object-contain");
  });

  it("uses hero strip when tall enough (MCP Apps iframe screenshot)", () => {
    renderArchBlock(
      {
        ...baseData,
        label: "iFrame View",
        subtitle: "Sandboxed HTML",
        imageSrc: "/doom.png",
        imageAlt: "DOOM",
      },
      240,
      140,
    );
    const img = screen.getByRole("img", { name: "DOOM" });
    expect(img.className).toContain("object-cover");
    expect(img.className).toContain("h-full");
  });

  it("renders logos row in compact layout when set (over single image/icon)", () => {
    renderArchBlock({
      label: "AI model",
      color: "#3b82f6",
      status: "neutral",
      logos: [
        { src: "/claude_logo.png", alt: "Claude" },
        { src: "/openai_logo.png", alt: "ChatGPT" },
      ],
    });
    expect(screen.getByRole("img", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ChatGPT" })).toBeInTheDocument();
  });
});

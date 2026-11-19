import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createConnectedServer } from "@/test/factories";

vi.mock("@/hooks/use-hosted-oauth-connections", () => ({
  useHostedOAuthConnections: () => ({ connections: [], shared: false, loaded: true }),
}));

import { ServerInfoContent } from "../ServerInfoContent";

const server = createConnectedServer({
  name: "atlas",
  initializationInfo: {
    protocolVersion: "2025-11-25",
    serverCapabilities: { tools: {}, prompts: {} },
  },
});

describe("ServerInfoContent's capabilities", () => {
  it("reads initializationInfo when the canvas gives it nothing", () => {
    render(<ServerInfoContent sections="info" server={server} />);
    expect(screen.getByText("Tools, Prompts")).toBeInTheDocument();
  });

  it("shows the server canvas's evaluated capabilities instead", () => {
    render(
      <ServerInfoContent
        sections="info"
        server={server}
        evaluatedCapabilities={["Tools", "Resources"]}
      />,
    );
    expect(screen.getByText("Tools, Resources")).toBeInTheDocument();
    expect(screen.queryByText("Tools, Prompts")).toBeNull();
  });
});

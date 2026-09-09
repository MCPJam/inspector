import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AgentSidePanelTrigger } from "../AgentSidePanelTrigger";
it("does not expose global chat during the Describe-only MVP", () => {
  render(<AgentSidePanelTrigger />);
  expect(screen.queryByRole("button", {name:"Ask MCPJam"})).toBeNull();
});

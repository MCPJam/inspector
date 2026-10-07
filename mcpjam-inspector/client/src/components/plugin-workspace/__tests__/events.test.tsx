import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PluginWorkspaceEvents } from "../PluginWorkspaceEvents";
const recording = {
  version: 2,
  runtime: "codex",
  sequence: 1,
  droppedEvents: 0,
  instances: [],
  events: [
    {
      sequence: 1,
      kind: "call-completed",
      instanceId: "b83ebc97-291c-4b9e-bac0-c651fa4641aa",
      generation: 1,
      operationId: "b83ebc97-291c-4b9e-bac0-c651fa4641ab",
      feature: "file-write",
      fidelity: "observed",
      outcome: "conflict",
    },
  ],
};
describe("workspace trace events", () => {
  it("displays validated host events outside the replay frame", () => {
    render(<PluginWorkspaceEvents recording={recording} />);
    expect(
      screen.getByText("call-completed · file-write (observed) · conflict"),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });
  it("does not render unknown or app-authored metadata", () => {
    const { container } = render(
      <PluginWorkspaceEvents
        recording={{ ...recording, title: "untrusted" }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunHostWorkspace } from "../unattended/RunHostWorkspace";
import { useWidgetPresentation } from "../../chat-v2/thread/widget-presentation";
function Presentation({ label }: { label: string }) {
  return (
    <span>
      {label}: {useWidgetPresentation()}
    </span>
  );
}
describe("unattended host layout", () => {
  it("uses the shared panel and scopes static presentation only to the transcript", () => {
    const { container } = render(
      <RunHostWorkspace
        appOpen
        transcript={<Presentation label="Transcript" />}
        appPanel={<Presentation label="Panel" />}
      />,
    );
    expect(screen.getByText("Transcript: placeholder")).toBeInTheDocument();
    expect(screen.getByText("Panel: live")).toBeInTheDocument();
    expect(
      container.querySelectorAll("[data-host-workspace-app-panel]"),
    ).toHaveLength(1);
    expect(container.querySelector("h1, ol, iframe")).toBeNull();
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HostWorkspace } from "../HostWorkspace";

describe("HostWorkspace presentation boundary", () => {
  it("preserves the original root and child order without extra wrappers", () => {
    const { container } = render(
      <HostWorkspace>
        <div>Conversation</div>
        <textarea aria-label="Draft" />
      </HostWorkspace>,
    );
    expect(container.firstElementChild?.className).toBe(
      "relative flex flex-col flex-1 min-h-0",
    );
    expect(container.firstElementChild?.children).toHaveLength(2);
  });
  it("keeps the App beside its usable thread without remounting", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 1200 } as DOMRect);
    const view = (open: boolean) => (
      <HostWorkspace appOpen={open} appPanel={<input aria-label="App draft" />}>
        <p>Chat</p>
      </HostWorkspace>
    );
    const { container, rerender } = render(view(true));
    const input = screen.getByLabelText("App draft");
    fireEvent.change(input, { target: { value: "retained" } });
    expect(container.firstElementChild).toHaveAttribute(
      "data-host-workspace-split",
      "true",
    );
    expect(
      container.querySelector("[data-host-workspace-app-panel]"),
    ).toHaveStyle({ width: "50%" });
    rerender(view(false));
    rerender(view(true));
    expect(screen.getByLabelText("App draft")).toBe(input);
    expect(input).toHaveValue("retained");
    rect.mockRestore();
    vi.unstubAllGlobals();
  });

  it("takes a narrow lane over without remounting the conversation or the App", () => {
    let resize = () => {};
    let width = 1000;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ width, height: 800 } as DOMRect));
    const view = (open: boolean) => (
      <HostWorkspace appOpen={open} appPanel={<input aria-label="App state" />}>
        <p>Conversation</p>
        <textarea aria-label="Chat draft" />
      </HostWorkspace>
    );
    const { container, rerender } = render(view(true));
    const draft = screen.getByLabelText("Chat draft");
    const app = screen.getByLabelText("App state");
    fireEvent.change(draft, { target: { value: "Unsent" } });
    fireEvent.change(app, { target: { value: "App retained" } });
    act(() => {
      width = 500;
      resize();
    });
    expect(container.firstElementChild).toHaveAttribute(
      "data-host-workspace-takeover",
      "true",
    );
    expect(
      container.querySelector("[data-host-workspace-app-panel]"),
    ).toHaveStyle({ width: "100%" });
    rerender(view(false));
    expect(draft).toBeVisible();
    expect(app).not.toBeVisible();
    rerender(view(true));
    act(() => {
      width = 1100;
      resize();
    });
    expect(screen.getByLabelText("Chat draft")).toBe(draft);
    expect(draft).toHaveValue("Unsent");
    expect(screen.getByLabelText("App state")).toBe(app);
    expect(app).toHaveValue("App retained");
    rect.mockRestore();
    vi.unstubAllGlobals();
  });
  it("keeps caller-owned draft and focus through presentation updates", () => {
    const mount = vi.fn();
    function Composer() {
      const [draft, setDraft] = useState("");
      mount();
      return (
        <textarea
          aria-label="Draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      );
    }
    const { rerender } = render(
      <HostWorkspace>
        <p>Empty</p>
        <Composer />
      </HostWorkspace>,
    );
    const input = screen.getByLabelText("Draft");
    input.focus();
    fireEvent.change(input, { target: { value: "retained" } });
    rerender(
      <HostWorkspace>
        <p>Updated</p>
        <Composer />
      </HostWorkspace>,
    );
    expect(screen.getByLabelText("Draft")).toBe(input);
    expect(input).toHaveValue("retained");
    expect(input).toHaveFocus();
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UrlElicitationRequiredDialog } from "../ElicitationRequestDialog";
import type { HostedElicitationUrlRequiredEvent } from "@/shared/hosted-elicitation";

let openSpy: ReturnType<typeof vi.fn>;

function urlRequired(
  n: number,
  toolCallId = "call-1",
): HostedElicitationUrlRequiredEvent {
  return {
    kind: "url_required",
    serverId: "srv-1",
    serverName: "GitHub",
    toolCallId,
    elicitations: Array.from({ length: n }, (_, i) => ({
      url: `https://example.com/step-${i + 1}`,
      elicitationId: `e${i + 1}`,
      message: `Do step ${i + 1}`,
    })),
  };
}

function openIt() {
  fireEvent.click(screen.getByRole("button", { name: /open in new tab/i }));
}

beforeEach(() => {
  openSpy = vi.fn(() => ({ opener: {}, location: { replace: vi.fn() } }));
  vi.stubGlobal("open", openSpy);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UrlElicitationRequiredDialog", () => {
  it("renders nothing without an event", () => {
    const { container } = render(
      <UrlElicitationRequiredDialog event={null} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("dismisses after the single required interaction", () => {
    const onDismiss = vi.fn();
    render(
      <UrlElicitationRequiredDialog event={urlRequired(1)} onDismiss={onDismiss} />,
    );
    expect(screen.getByText(/Do step 1/)).toBeInTheDocument();
    // One entry — no counter noise.
    expect(screen.queryByText(/1 of 1/)).not.toBeInTheDocument();

    openIt();
    expect(onDismiss).toHaveBeenCalledWith("call-1");
  });

  it("walks every entry before dismissing", () => {
    // The spec allows several required interactions, and they're conjunctive:
    // finishing one doesn't unblock the tool. Showing only the first and
    // discarding the rest left the user permanently stuck.
    const onDismiss = vi.fn();
    render(
      <UrlElicitationRequiredDialog event={urlRequired(3)} onDismiss={onDismiss} />,
    );

    expect(screen.getByText(/Do step 1 \(1 of 3\)/)).toBeInTheDocument();
    openIt();
    expect(onDismiss).not.toHaveBeenCalled();

    expect(screen.getByText(/Do step 2 \(2 of 3\)/)).toBeInTheDocument();
    openIt();
    expect(onDismiss).not.toHaveBeenCalled();

    expect(screen.getByText(/Do step 3 \(3 of 3\)/)).toBeInTheDocument();
    openIt();
    expect(onDismiss).toHaveBeenCalledWith("call-1");
  });

  it("opens each entry's own url, not the first one repeatedly", () => {
    const replace = vi.fn();
    openSpy.mockReturnValue({ opener: {}, location: { replace } });
    render(
      <UrlElicitationRequiredDialog event={urlRequired(2)} onDismiss={vi.fn()} />,
    );

    openIt();
    openIt();

    expect(replace).toHaveBeenNthCalledWith(1, "https://example.com/step-1");
    expect(replace).toHaveBeenNthCalledWith(2, "https://example.com/step-2");
  });

  it("restarts the walk when a new failure arrives", () => {
    const { rerender } = render(
      <UrlElicitationRequiredDialog event={urlRequired(2)} onDismiss={vi.fn()} />,
    );
    openIt();
    expect(screen.getByText(/Do step 2/)).toBeInTheDocument();

    rerender(
      <UrlElicitationRequiredDialog
        event={urlRequired(2, "call-2")}
        onDismiss={vi.fn()}
      />,
    );

    // A different tool failed — start from its first requirement, not wherever
    // the previous walk happened to stop.
    expect(screen.getByText(/Do step 1 \(1 of 2\)/)).toBeInTheDocument();
  });
});

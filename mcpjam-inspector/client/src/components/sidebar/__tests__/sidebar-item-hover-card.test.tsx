import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_HOVER_CLOSE_DELAY_MS,
  SIDEBAR_HOVER_OPEN_DELAY_MS,
  SidebarItemHoverCard,
} from "../sidebar-item-hover-card";

// From learnMoreContent["servers"]: present only when the clip section is.
const SERVERS_DESCRIPTION = "Connect and manage your MCP servers.";

type CardProps = Partial<React.ComponentProps<typeof SidebarItemHoverCard>>;

function card(row: string, props: CardProps = {}) {
  return (
    <SidebarItemHoverCard title={`${row} title`} {...props}>
      <button type="button">{row}</button>
    </SidebarItemHoverCard>
  );
}

function row(name: string) {
  return screen.getByRole("button", { name });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function hover(name: string) {
  fireEvent.pointerEnter(row(name), { pointerType: "mouse" });
}

function unhover(name: string) {
  fireEvent.pointerLeave(row(name), { pointerType: "mouse" });
}

function isOpen(name: string) {
  return screen.queryByText(`${name} title`) !== null;
}

// The card trusts focus only when the last input was a key press, not a
// pointer press. Call after render: the first card installs the listeners.
function lastInput(source: "keyboard" | "pointer") {
  if (source === "keyboard") {
    fireEvent.keyDown(document.body, { key: "Tab" });
  } else {
    fireEvent.pointerDown(document.body);
  }
}

let pause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom implements neither; the card only needs them to be callable.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SidebarItemHoverCard timing", () => {
  it("opens after the open delay", () => {
    render(card("A"));
    hover("A");

    advance(SIDEBAR_HOVER_OPEN_DELAY_MS - 1);
    expect(isOpen("A")).toBe(false);
    advance(1);
    expect(isOpen("A")).toBe(true);
  });

  it("never opens when the pointer leaves before the open delay", () => {
    render(card("A"));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS / 2);
    unhover("A");

    advance(SIDEBAR_HOVER_OPEN_DELAY_MS * 5);
    expect(isOpen("A")).toBe(false);
  });

  it("closes after the close delay once the pointer leaves", () => {
    render(card("A"));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);
    unhover("A");

    advance(SIDEBAR_HOVER_CLOSE_DELAY_MS - 1);
    expect(isOpen("A")).toBe(true);
    advance(1);
    expect(isOpen("A")).toBe(false);
  });
});

describe("SidebarItemHoverCard content", () => {
  it("shows the title alone when there is nothing else to say", () => {
    render(card("A"));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(screen.getByText("A title")).toHaveAttribute(
      "data-slot",
      "hover-card-header"
    );
    expect(
      document.querySelector("[data-slot='hover-card-body']")
    ).toBeNull();
  });

  it("puts the badge in the pill with the inverse variant", () => {
    render(card("A", { badge: "New" }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    const badge = screen.getByText("New");
    expect(screen.getByText("A title")).toContainElement(badge);
    expect(badge).toHaveClass("bg-primary-foreground", "text-primary");
  });

  it("adds the clip section when the entry has a clip and onExpand is set", () => {
    render(card("A", { tabId: "servers", onExpand: vi.fn() }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(screen.getByText(SERVERS_DESCRIPTION)).toBeInTheDocument();
    expect(document.querySelector("video")).toHaveProperty("autoplay", true);
  });

  it("leaves the clip out when the learn-more flag is off", () => {
    render(card("A", { tabId: "servers" }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(isOpen("A")).toBe(true);
    expect(screen.queryByText(SERVERS_DESCRIPTION)).not.toBeInTheDocument();
  });

  it("shows the disabled message in the body", () => {
    render(card("A", { disabledMessage: "Available locally" }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(screen.getByText("Available locally")).toBeInTheDocument();
  });

  it("stays shut beside a visible label when it has nothing to add", () => {
    render(card("A", { labelVisible: true }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS * 2);

    expect(isOpen("A")).toBe(false);
  });

  it("opens beside a visible label when it has a body", () => {
    render(card("A", { labelVisible: true, disabledMessage: "Locked" }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(screen.getByText("Locked")).toBeInTheDocument();
  });

  it("hands expand the learn-more key", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const onExpand = vi.fn();
    render(card("A", { tabId: "servers", onExpand }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    fireEvent.click(
      screen.getByRole("button", { name: "Learn more about Servers" })
    );

    expect(onExpand).toHaveBeenCalledWith("servers", expect.anything());
    expect(isOpen("A")).toBe(false);
  });
});

describe("SidebarItemHoverCard focus", () => {
  it("opens on keyboard focus", () => {
    render(card("A"));
    lastInput("keyboard");
    act(() => row("A").focus());
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(isOpen("A")).toBe(true);
  });

  it("ignores focus from a click or a closing menu", () => {
    render(card("A"));
    lastInput("pointer");
    act(() => row("A").focus());
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS * 2);

    expect(isOpen("A")).toBe(false);
  });

  it("ignores focus after a keyboard shortcut such as switching windows", () => {
    render(card("A"));
    lastInput("pointer");
    fireEvent.keyDown(document.body, { key: "Tab", metaKey: true });
    fireEvent.keyDown(document.body, { key: "Meta" });
    act(() => row("A").focus());
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS * 2);

    expect(isOpen("A")).toBe(false);
  });
});

describe("SidebarItemHoverCard suppression", () => {
  it("drops an open scheduled before suppression, even if released early", () => {
    const { rerender } = render(card("A"));
    hover("A");
    rerender(card("A", { suppressed: true }));
    rerender(card("A", { suppressed: false }));

    advance(SIDEBAR_HOVER_OPEN_DELAY_MS * 2);
    expect(isOpen("A")).toBe(false);
  });

  it("closes when suppressed and stays shut once released", () => {
    const { rerender } = render(card("A"));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);
    expect(isOpen("A")).toBe(true);

    rerender(card("A", { suppressed: true }));
    expect(isOpen("A")).toBe(false);
    rerender(card("A", { suppressed: false }));
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS * 2);
    expect(isOpen("A")).toBe(false);
  });

  it("opens again on the next hover after a release", () => {
    const { rerender } = render(card("A"));
    hover("A");
    rerender(card("A", { suppressed: true }));
    rerender(card("A", { suppressed: false }));
    unhover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS * 2);

    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);
    expect(isOpen("A")).toBe(true);
  });
});

describe("SidebarItemHoverCard one at a time", () => {
  function pair() {
    return (
      <>
        {card("A", { tabId: "servers", onExpand: vi.fn() })}
        {card("B")}
      </>
    );
  }

  it("closes the open card the moment another opens", () => {
    render(pair());
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);
    // The pointer rests in A's card, so A's own close never starts.
    hover("B");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(isOpen("B")).toBe(true);
    expect(isOpen("A")).toBe(false);
  });

  it("closes a focused item's card when another is hovered", () => {
    render(pair());
    lastInput("keyboard");
    act(() => row("A").focus());
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);
    expect(isOpen("A")).toBe(true);

    hover("B");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    expect(isOpen("B")).toBe(true);
    expect(isOpen("A")).toBe(false);
  });

  it("doesn't let a late close from the previous card shut the new one", () => {
    render(pair());
    lastInput("keyboard");
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    act(() => row("B").focus());
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS / 2);
    // A's close timer outlives B's open timer.
    unhover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS / 2);
    expect(isOpen("B")).toBe(true);

    advance(SIDEBAR_HOVER_CLOSE_DELAY_MS);
    expect(isOpen("B")).toBe(true);
    expect(isOpen("A")).toBe(false);
  });

  it("pauses the clip of a card that closes", () => {
    render(pair());
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);
    expect(pause).not.toHaveBeenCalled();

    hover("B");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);
    expect(pause).toHaveBeenCalled();
  });
});

describe("SidebarItemHoverCard pressed inside", () => {
  it("closes when a press that started in the card ends outside it", () => {
    render(card("A", { tabId: "servers", onExpand: vi.fn() }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    fireEvent.pointerDown(screen.getByText(SERVERS_DESCRIPTION));
    unhover("A");
    fireEvent.pointerUp(document.body);

    expect(isOpen("A")).toBe(false);
  });

  it("stays open when the press ends inside the card", () => {
    render(card("A", { tabId: "servers", onExpand: vi.fn() }));
    hover("A");
    advance(SIDEBAR_HOVER_OPEN_DELAY_MS);

    const description = screen.getByText(SERVERS_DESCRIPTION);
    fireEvent.pointerDown(description);
    fireEvent.pointerUp(description);

    expect(isOpen("A")).toBe(true);
  });
});

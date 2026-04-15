import type { ReactNode } from "react";
import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import type { ModelDefinition } from "@/shared/types";
import { TranscriptThread } from "../thread/transcript-thread";

const mockMessageView = vi.fn();

vi.mock("../thread/message-view", () => ({
  MessageView: (props: {
    message: UIMessage;
    model: ModelDefinition;
    claudeFooterMode?: "none" | "animated" | "static";
  }) => {
    mockMessageView(props);
    const { message, model } = props;
    return (
      <div data-testid={`message-${message.id}`} data-role={message.role}>
        <span data-testid="message-model">{model.name}</span>
        {message.parts?.map((part, index) => (
          <span key={index} data-testid={`part-${index}`}>
            {(part as any).text || (part as any).type}
          </span>
        ))}
      </div>
    );
  },
}));

const originalResizeObserver = global.ResizeObserver;
const originalMutationObserver = global.MutationObserver;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];

  callback: ResizeObserverCallback;
  observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControlledResizeObserver.instances.push(this);
  }

  observe = vi.fn((element: Element) => {
    this.observed.add(element);
  });

  unobserve = vi.fn((element: Element) => {
    this.observed.delete(element);
  });

  disconnect = vi.fn(() => {
    this.observed.clear();
  });

  trigger(elements?: Element[]) {
    const targets = (elements ?? Array.from(this.observed)).filter((element) =>
      this.observed.has(element),
    );
    if (targets.length === 0) return;

    this.callback(
      targets.map(
        (target) =>
          ({
            target,
            contentRect: target.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          }) as ResizeObserverEntry,
      ),
      this as unknown as ResizeObserver,
    );
  }

  static latest() {
    return ControlledResizeObserver.instances[
      ControlledResizeObserver.instances.length - 1
    ];
  }

  static reset() {
    ControlledResizeObserver.instances = [];
  }
}

class ControlledMutationObserver {
  static instances: ControlledMutationObserver[] = [];

  callback: MutationCallback;

  constructor(callback: MutationCallback) {
    this.callback = callback;
    ControlledMutationObserver.instances.push(this);
  }

  observe = vi.fn();

  disconnect = vi.fn();

  takeRecords = vi.fn(() => []);

  trigger(records: MutationRecord[] = []) {
    this.callback(records, this as unknown as MutationObserver);
  }

  static latest() {
    return ControlledMutationObserver.instances[
      ControlledMutationObserver.instances.length - 1
    ];
  }

  static reset() {
    ControlledMutationObserver.instances = [];
  }
}

function installTimerBackedAnimationFrame() {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    window.clearTimeout(handle);
  });
}

function mockElementRect(
  element: Element,
  {
    top,
    height,
    left = 0,
    width = 400,
  }: {
    top: number;
    height: number;
    left?: number;
    width?: number;
  },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

function renderInScrollHost(ui: ReactNode, options?: { overflowY?: string }) {
  const scrollHost = document.createElement("div");
  scrollHost.setAttribute("data-testid", "transcript-scroll-host");
  scrollHost.style.overflowY = options?.overflowY ?? "auto";
  document.body.appendChild(scrollHost);

  const root = document.createElement("div");
  scrollHost.appendChild(root);

  const scrollTo = vi.fn();
  Object.defineProperty(scrollHost, "clientHeight", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(scrollHost, "scrollHeight", {
    configurable: true,
    value: 1200,
  });
  Object.defineProperty(scrollHost, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });
  Object.defineProperty(scrollHost, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  mockElementRect(scrollHost, { top: 100, height: 200 });

  return {
    scrollHost,
    scrollTo,
    root,
    ...render(ui, { container: root }),
  };
}

describe("TranscriptThread", () => {
  const model: ModelDefinition = {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    contextLength: 8192,
  };

  const messages: UIMessage[] = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Hi there" }],
    },
  ];

  const defaultProps = {
    messages,
    model,
    toolsMetadata: {},
    toolServerMap: {},
    contentClassName: "space-y-8",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.ResizeObserver = originalResizeObserver;
    global.MutationObserver = originalMutationObserver;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    ControlledResizeObserver.reset();
    ControlledMutationObserver.reset();
    document
      .querySelectorAll('[data-testid="transcript-scroll-host"]')
      .forEach((node) => node.remove());
  });

  it("renders message wrappers by message id and applies highlight metadata", () => {
    render(
      <TranscriptThread
        {...defaultProps}
        focusMessageId="assistant-1"
        highlightedMessageIds={["assistant-1"]}
      />,
    );

    const wrapper = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute("data-focused", "true");
    expect(wrapper).toHaveAttribute("data-highlighted", "true");
    expect(wrapper).toHaveAttribute("data-guided", "true");
    expect(wrapper?.className).toContain("bg-primary/5");
    expect(screen.getByTestId("transcript-focus-guide")).toBeInTheDocument();
    expect(screen.getByTestId("message-assistant-1")).toBeInTheDocument();
  });

  it("enables content-visibility containment by default", () => {
    render(<TranscriptThread {...defaultProps} />);

    const wrapper = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.contentVisibility).toBe("auto");
    expect(wrapper?.style.containIntrinsicSize).toBe("0 160px");
  });

  it("disables content-visibility containment while a fullscreen widget is active", () => {
    render(
      <TranscriptThread {...defaultProps} fullscreenWidgetId="tool-call-1" />,
    );

    const wrapper = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.contentVisibility).toBe("");
    expect(wrapper?.style.containIntrinsicSize).toBe("");
  });

  it("disables content-visibility containment while a pip widget is active", () => {
    render(<TranscriptThread {...defaultProps} pipWidgetId="tool-call-1" />);

    const wrapper = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.contentVisibility).toBe("");
    expect(wrapper?.style.containIntrinsicSize).toBe("");
  });

  it("uses the resolved Claude variant to attach an animated footer to the latest assistant message", () => {
    render(
      <TranscriptThread
        {...defaultProps}
        isLoading={true}
        resolvedLoadingIndicatorVariant="claude-mark"
        lastRenderableMessageId="assistant-1"
      />,
    );

    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: "assistant-1" }),
        claudeFooterMode: "animated",
      }),
    );
    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: "user-1" }),
        claudeFooterMode: "none",
      }),
    );
  });

  it("uses the resolved Claude variant to keep the latest assistant footer static after loading", () => {
    render(
      <TranscriptThread
        {...defaultProps}
        isLoading={false}
        resolvedLoadingIndicatorVariant="claude-mark"
        lastRenderableMessageId="assistant-1"
      />,
    );

    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: "assistant-1" }),
        claudeFooterMode: "static",
      }),
    );
  });

  it("scrolls the focused message using the nearest scrollable ancestor", () => {
    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    const { scrollTo } = renderInScrollHost(
      <TranscriptThread
        {...defaultProps}
        focusMessageId="assistant-1"
        highlightedMessageIds={["assistant-1"]}
        navigationKey={1}
      />,
    );

    const target = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement;
    mockElementRect(target, { top: 520, height: 40 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({
        top: 340,
        behavior: "smooth",
      }),
    );
  });

  it("uses viewportRef overrides and retriggers the same target when navigationKey changes", () => {
    const viewportRef = createRef<HTMLElement>();
    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    const { scrollHost, scrollTo, rerender } = renderInScrollHost(
      <TranscriptThread
        {...defaultProps}
        focusMessageId="assistant-1"
        highlightedMessageIds={["assistant-1"]}
        navigationKey={1}
        viewportRef={viewportRef}
      />,
      { overflowY: "visible" },
    );

    viewportRef.current = scrollHost;

    const target = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement;
    mockElementRect(target, { top: 520, height: 40 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        top: 340,
        behavior: "smooth",
      }),
    );

    mockElementRect(target, { top: 420, height: 40 });
    rerender(
      <TranscriptThread
        {...defaultProps}
        focusMessageId="assistant-1"
        highlightedMessageIds={["assistant-1"]}
        navigationKey={2}
        viewportRef={viewportRef}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        top: 240,
        behavior: "smooth",
      }),
    );
  });

  it("top-anchors taller focused messages instead of centering them", () => {
    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    const { scrollTo } = renderInScrollHost(
      <TranscriptThread
        {...defaultProps}
        focusMessageId="assistant-1"
        highlightedMessageIds={["assistant-1"]}
        navigationKey={1}
      />,
    );

    const target = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement;
    mockElementRect(target, { top: 520, height: 120 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({
        top: 404,
        behavior: "smooth",
      }),
    );
  });

  it("re-scrolls on resize and mutation until the transcript settles", () => {
    global.ResizeObserver =
      ControlledResizeObserver as unknown as typeof ResizeObserver;
    global.MutationObserver =
      ControlledMutationObserver as unknown as typeof MutationObserver;
    vi.useFakeTimers();
    installTimerBackedAnimationFrame();

    const { scrollTo, root } = renderInScrollHost(
      <TranscriptThread
        {...defaultProps}
        focusMessageId="assistant-1"
        highlightedMessageIds={["assistant-1"]}
        navigationKey={1}
      />,
    );

    const target = document.querySelector(
      '[data-message-id="assistant-1"]',
    ) as HTMLElement;
    mockElementRect(target, { top: 520, height: 40 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        top: 340,
        behavior: "smooth",
      }),
    );

    const resizeObserver = ControlledResizeObserver.latest();
    const mutationObserver = ControlledMutationObserver.latest();
    expect(resizeObserver).toBeDefined();
    expect(mutationObserver).toBeDefined();

    mockElementRect(target, { top: 260, height: 40 });
    act(() => {
      resizeObserver?.trigger([target]);
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        top: 80,
        behavior: "auto",
      }),
    );

    mockElementRect(target, { top: 300, height: 40 });
    act(() => {
      mutationObserver?.trigger([
        {
          addedNodes: root.childNodes,
          removedNodes: [] as any,
          type: "childList",
          target: root,
          attributeName: null,
          attributeNamespace: null,
          nextSibling: null,
          oldValue: null,
          previousSibling: null,
        } as MutationRecord,
      ]);
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        top: 120,
        behavior: "auto",
      }),
    );

    act(() => {
      vi.advanceTimersByTime(120);
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        top: 120,
        behavior: "auto",
      }),
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(scrollTo).toHaveBeenCalledTimes(4);
  });
});

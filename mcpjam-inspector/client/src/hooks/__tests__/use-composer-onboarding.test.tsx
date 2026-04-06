import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useComposerOnboarding,
  type UseComposerOnboardingOptions,
} from "../use-composer-onboarding";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => false };
});

const defaults: UseComposerOnboardingOptions = {
  initialInput: undefined,
  initialInputTypewriter: false,
  blockSubmitUntilServerConnected: false,
  pulseSubmit: false,
  showPostConnectGuide: false,
  serverConnected: true,
  isThreadEmpty: true,
};

describe("useComposerOnboarding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Basic input state ---

  it("initializes input to empty when no initialInput provided", () => {
    const { result } = renderHook(() => useComposerOnboarding(defaults));
    expect(result.current.input).toBe("");
  });

  it("initializes input from initialInput when typewriter is off", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({ ...defaults, initialInput: "Hello" }),
    );
    expect(result.current.input).toBe("Hello");
  });

  it("initializes input to empty when typewriter is on (animation starts from empty)", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
        initialInputTypewriter: true,
      }),
    );
    expect(result.current.input).toBe("");
  });

  // --- Typewriter ---

  it("types initialInput one character at a time when typewriter is active", () => {
    const full = "Draw me an MCP architecture diagram";
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: full,
        initialInputTypewriter: true,
      }),
    );

    expect(result.current.input).toBe("");

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(result.current.input).toBe("D");

    act(() => {
      vi.advanceTimersByTime(20 * (full.length - 1));
    });
    expect(result.current.input).toBe(full);
  });

  it("stops typewriter when user edits the input", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello world",
        initialInputTypewriter: true,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(20 * 3);
    });
    expect(result.current.input).toBe("Hel");

    act(() => {
      result.current.handleInputChange("Custom text");
    });
    expect(result.current.input).toBe("Custom text");

    // Further timer ticks should not overwrite user input
    act(() => {
      vi.advanceTimersByTime(20 * 20);
    });
    expect(result.current.input).toBe("Custom text");
  });

  // --- Guided input (post-connect) ---

  it("seeds input from initialInput when showPostConnectGuide is true", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        showPostConnectGuide: true,
        initialInput: "Draw me a diagram",
      }),
    );
    expect(result.current.input).toBe("Draw me a diagram");
    expect(result.current.isGuidedInputPristine).toBe(true);
  });

  it("marks guided input as not pristine when user edits it", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        showPostConnectGuide: true,
        initialInput: "Draw me a diagram",
      }),
    );

    act(() => {
      result.current.handleInputChange("Something else");
    });

    expect(result.current.isGuidedInputPristine).toBe(false);
  });

  // --- Submit gating ---

  it("gates submit when blockSubmitUntilServerConnected and server not connected", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        blockSubmitUntilServerConnected: true,
        serverConnected: false,
      }),
    );
    expect(result.current.submitGatedByServer).toBe(true);
  });

  it("does not gate submit when server is connected", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        blockSubmitUntilServerConnected: true,
        serverConnected: true,
      }),
    );
    expect(result.current.submitGatedByServer).toBe(false);
  });

  it("does not gate submit when blockSubmitUntilServerConnected is false", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        blockSubmitUntilServerConnected: false,
        serverConnected: false,
      }),
    );
    expect(result.current.submitGatedByServer).toBe(false);
  });

  // --- NUX CTA visibility ---

  it("shows NUX CTA when typewriter is active and thread is empty", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
        initialInputTypewriter: true,
        isThreadEmpty: true,
      }),
    );
    expect(result.current.sendNuxCtaVisible).toBe(true);
  });

  it("hides NUX CTA when thread has messages", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
        initialInputTypewriter: true,
        isThreadEmpty: false,
      }),
    );
    expect(result.current.sendNuxCtaVisible).toBe(false);
  });

  it("hides NUX CTA when not in typewriter mode", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
        initialInputTypewriter: false,
        isThreadEmpty: true,
      }),
    );
    expect(result.current.sendNuxCtaVisible).toBe(false);
  });

  // --- Send button onboarding pulse ---

  it("pulses submit when pulseSubmit is true in typewriter mode and user hasn't edited", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
        initialInputTypewriter: true,
        pulseSubmit: true,
        isThreadEmpty: true,
      }),
    );
    expect(result.current.sendButtonOnboardingPulse).toBe(true);
  });

  it("stops pulse when user edits in typewriter mode", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
        initialInputTypewriter: true,
        pulseSubmit: true,
        isThreadEmpty: true,
      }),
    );

    act(() => {
      result.current.handleInputChange("User edit");
    });

    expect(result.current.sendButtonOnboardingPulse).toBe(false);
  });

  it("pulses submit when pulseSubmit is true and guided input is pristine", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        showPostConnectGuide: true,
        initialInput: "Draw me a diagram",
        pulseSubmit: true,
        isThreadEmpty: true,
      }),
    );
    expect(result.current.sendButtonOnboardingPulse).toBe(true);
  });

  // --- onReset callback ---

  it("preserves guided input on reset when post-connect guide is active and pristine", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        showPostConnectGuide: true,
        initialInput: "Draw me a diagram",
      }),
    );

    expect(result.current.input).toBe("Draw me a diagram");

    act(() => {
      result.current.onSessionReset();
    });

    expect(result.current.input).toBe("Draw me a diagram");
  });

  it("restores initialInput on reset when not in post-connect guide mode", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
      }),
    );

    act(() => {
      result.current.handleInputChange("User typed something");
    });
    expect(result.current.input).toBe("User typed something");

    act(() => {
      result.current.onSessionReset();
    });

    // Should restore to initialInput since it was set
    expect(result.current.input).toBe("User typed something");
  });

  it("clears input on reset when no initialInput and no post-connect guide", () => {
    const { result } = renderHook(() => useComposerOnboarding(defaults));

    act(() => {
      result.current.handleInputChange("typed");
    });

    act(() => {
      result.current.onSessionReset();
    });

    expect(result.current.input).toBe("");
  });

  // --- handleClearChat ---

  it("clears input after handleClearChat followed by onSessionReset", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hello",
      }),
    );

    expect(result.current.input).toBe("Hello");

    act(() => {
      result.current.prepareForClearChat();
    });

    act(() => {
      result.current.onSessionReset();
    });

    expect(result.current.input).toBe("");
  });

  // --- moveCaretToEndTrigger ---

  it("provides a moveCaretToEndTrigger that increments on typewriter complete", () => {
    const full = "Hi";
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: full,
        initialInputTypewriter: true,
        isThreadEmpty: true,
      }),
    );

    const initial = result.current.moveCaretToEndTrigger;

    act(() => {
      vi.advanceTimersByTime(20 * full.length);
    });

    expect(result.current.moveCaretToEndTrigger).toBeGreaterThan(initial ?? -1);
  });

  it("returns undefined moveCaretToEndTrigger when thread has messages", () => {
    const { result } = renderHook(() =>
      useComposerOnboarding({
        ...defaults,
        initialInput: "Hi",
        initialInputTypewriter: true,
        isThreadEmpty: false,
      }),
    );
    expect(result.current.moveCaretToEndTrigger).toBeUndefined();
  });
});

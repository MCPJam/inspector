/**
 * `copyToClipboard`'s return value is a PROMISE the callers act on — every
 * caller branches straight into a success or failure toast — so the boolean has
 * to describe what actually reached the clipboard, including in the deprecated
 * `execCommand` fallback, which reports failure by returning false rather than
 * by throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "../clipboard";

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function stubExecCommand(impl: () => boolean) {
  const execCommand = vi.fn(impl);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// Both stubs are installed with defineProperty rather than vi.spyOn (jsdom
// leaves `execCommand` undefined), so restoreAllMocks does not undo them —
// they have to be put back by hand or they leak into later tests.
afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
  vi.restoreAllMocks();
});

describe("copyToClipboard", () => {
  it("uses the Clipboard API when it resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await expect(copyToClipboard("https://example.test/x")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.test/x");
  });

  it("reports success when the execCommand fallback copies", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const execCommand = stubExecCommand(() => true);

    await expect(copyToClipboard("text")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The scratch textarea must not outlive the attempt.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports FAILURE when the execCommand fallback returns false", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    stubExecCommand(() => false);

    // Regression: this used to resolve `true`, so callers showed "Link copied"
    // for a copy the browser had refused.
    await expect(copyToClipboard("text")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when the fallback throws", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    stubExecCommand(() => {
      throw new Error("no execCommand");
    });

    await expect(copyToClipboard("text")).resolves.toBe(false);
    // A throw must not strand the scratch textarea in the document either.
    expect(document.querySelector("textarea")).toBeNull();
  });
});

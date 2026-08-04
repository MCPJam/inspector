/**
 * The wait that keeps a dismissal from shipping an unresolved tool call.
 * Its failure mode matters as much as its success one: blocking the user's
 * message forever would be worse than the invalid history it prevents.
 */
import { describe, expect, it } from "vitest";

import { waitForTerminalToolParts } from "../wait-for-tool-output";

const part = (toolCallId: string, state: string) => ({
  parts: [{ toolCallId, state }],
});

describe("waitForTerminalToolParts", () => {
  it("returns immediately when there is nothing to wait for", async () => {
    await expect(waitForTerminalToolParts(() => [], [])).resolves.toBe(true);
  });

  it("resolves as soon as the output lands", async () => {
    // A thunk, not a captured array: the SDK swaps the messages array on every
    // update, so a snapshot reference would never observe the transition.
    let messages = [part("tc-1", "input-available")];
    setTimeout(() => {
      messages = [part("tc-1", "output-available")];
    }, 20);

    await expect(
      waitForTerminalToolParts(() => messages, ["tc-1"], { timeoutMs: 500 }),
    ).resolves.toBe(true);
  });

  it("accepts any terminal output state, not just output-available", async () => {
    const messages = [part("tc-1", "output-error")];
    await expect(
      waitForTerminalToolParts(() => messages, ["tc-1"], { timeoutMs: 100 }),
    ).resolves.toBe(true);
  });

  it("waits for EVERY id, not just the first", async () => {
    const messages = [part("tc-1", "output-available"), part("tc-2", "input-available")];
    await expect(
      waitForTerminalToolParts(() => messages, ["tc-1", "tc-2"], {
        timeoutMs: 60,
        pollMs: 5,
      }),
    ).resolves.toBe(false);
  });

  it("gives up rather than blocking the user's message forever", async () => {
    // A stuck output is a bug; a permanently wedged composer is a worse one.
    const messages = [part("tc-1", "input-available")];
    await expect(
      waitForTerminalToolParts(() => messages, ["tc-1"], {
        timeoutMs: 60,
        pollMs: 5,
      }),
    ).resolves.toBe(false);
  });
});

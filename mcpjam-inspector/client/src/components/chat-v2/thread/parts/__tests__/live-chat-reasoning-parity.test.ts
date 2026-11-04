import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_CHAT_REASONING_DISPLAY_MODE } from "../reasoning-part";

/**
 * Every live chat surface shows reasoning the same way because none of them
 * sets a mode: they inherit `Thread`'s default. Read-only transcripts set
 * their own. Source-level on purpose: rendering `PlaygroundMain` needs most of
 * the app's providers, and the failure this guards is a call site, not a
 * render.
 */
const COMPONENTS = resolve(__dirname, "../../../..");

/** Live surfaces: inherit the default, never name a mode. */
const LIVE = [
  "ui-playground/PlaygroundMain.tsx",
  "ui-playground/multi-model-playground-card.tsx",
  "mcpjam-agent/McpjamAgentThread.tsx",
];

/** Read-only or host-styled surfaces that choose their own mode. */
const OWN_MODE = [
  "ChatTabV2.tsx",
  "chat-v2/multi-model-chat-card.tsx",
  "evals/trace-viewer.tsx",
];

/** Any string literal in a `reasoningDisplayMode` prop or default. */
const LITERAL_MODE =
  /reasoningDisplayMode\s*=\s*(?:\{\s*)?(?:"[^"]*"|'[^']*'|`[^`]*`)/;

function filesRenderingThread(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : filesRenderingThread(path);
    }
    return entry.name.endsWith(".tsx") &&
      /<Thread(\s|$)/m.test(readFileSync(path, "utf8"))
      ? [relative(COMPONENTS, path).replaceAll("\\", "/")]
      : [];
  });
}

const source = (path: string) => readFileSync(join(COMPONENTS, path), "utf8");

describe("live chat reasoning display parity", () => {
  it("collapses reasoning by default", () => {
    expect(LIVE_CHAT_REASONING_DISPLAY_MODE).toBe("collapsed");
    expect(source("chat-v2/thread.tsx")).toMatch(
      /reasoningDisplayMode = LIVE_CHAT_REASONING_DISPLAY_MODE,/,
    );
  });

  it("classifies every component that renders Thread", () => {
    // A new caller lands here first: decide whether it is live or sets its own.
    expect(filesRenderingThread(COMPONENTS).sort()).toEqual(
      [...LIVE, ...OWN_MODE].sort(),
    );
  });

  it.each(LIVE)("%s names no reasoning mode of its own", (path) => {
    expect(source(path)).not.toMatch(LITERAL_MODE);
  });
});

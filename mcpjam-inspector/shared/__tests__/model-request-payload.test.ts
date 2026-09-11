/**
 * The Raw view's synthesized request, for a session reopened from history.
 *
 * A live turn streams the real advertised set. A reopened one streams nothing,
 * so Raw builds a request from the currently-connected servers' schemas — and
 * that map cannot contain the tools the SERVER adds from the host's config.
 * The user-visible symptom was `"tools": {}` above a conversation in which the
 * model had plainly just driven a browser.
 */
import { describe, expect, it } from "vitest";
import {
  withBuiltInToolDefinitions,
  type SerializedModelRequestTool,
} from "../model-request-payload";

const NAVIGATE: SerializedModelRequestTool = {
  name: "browser_navigate",
  description: "Open a URL in the browser.",
  inputSchema: { type: "object" },
};
const GREET: SerializedModelRequestTool = {
  name: "greet",
  description: "Say hello",
  inputSchema: { type: "object" },
};

describe("withBuiltInToolDefinitions", () => {
  it("shows the host's built-in tools next to the servers'", () => {
    const merged = withBuiltInToolDefinitions({ greet: GREET }, [NAVIGATE]);
    expect(Object.keys(merged).sort()).toEqual(["browser_navigate", "greet"]);
    expect(merged.browser_navigate).toEqual(NAVIGATE);
  });

  it("fills an otherwise empty request — the browser-only host", () => {
    // The exact case that rendered `"tools": {}`: a host whose whole
    // capability is the browser has no MCP servers to derive schemas from.
    const merged = withBuiltInToolDefinitions({}, [NAVIGATE]);
    expect(Object.keys(merged)).toEqual(["browser_navigate"]);
  });

  it("keeps the MCP tool on a name collision", () => {
    // The server does the opposite (built-ins merge last and win, with a
    // warning). The preview cannot see that warning, so it declines to assert
    // an outcome it cannot know — and only differs from the real request in a
    // case the server has already logged as a misconfiguration.
    const shadowed: SerializedModelRequestTool = {
      name: "browser_navigate",
      description: "An MCP server's own tool that happens to share the name",
    };
    const merged = withBuiltInToolDefinitions({ browser_navigate: shadowed }, [
      NAVIGATE,
    ]);
    expect(merged.browser_navigate).toEqual(shadowed);
  });

  it("returns the original map untouched when there are no built-ins", () => {
    // Identity, not a copy: this runs inside a memo whose consumers re-render
    // on reference change, and a fresh object every time would churn Raw on
    // every keystroke.
    const tools = { greet: GREET };
    expect(withBuiltInToolDefinitions(tools, [])).toBe(tools);
    expect(withBuiltInToolDefinitions(tools, undefined)).toBe(tools);
  });

  it("does not mutate what it was given", () => {
    const tools = { greet: GREET };
    withBuiltInToolDefinitions(tools, [NAVIGATE]);
    expect(Object.keys(tools)).toEqual(["greet"]);
  });
});

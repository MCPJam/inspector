import { describe, expect, it } from "vitest";
import { splitServerAttribution } from "../server-error-copy";

const PIN_FAILURE =
  'MCP server "champions" doesn\'t support MCP protocol version 2026-07-28, which this client is pinned to.';

describe("splitServerAttribution", () => {
  it("names the server on a generic failure", () => {
    // The regression this exists to prevent: dropping the route's preamble
    // left "Connection refused" with nothing saying which server refused.
    expect(splitServerAttribution("champions", "Connection refused")).toEqual({
      title: "champions",
      description: "Connection refused",
    });
  });

  it("does not repeat a name the message already carries", () => {
    // The stutter the preamble caused, in the other direction. The SDK's
    // pinned-version error opens with the server name, so a title above it
    // would read "champions" over 'MCP server "champions" doesn't support …'.
    expect(splitServerAttribution("champions", PIN_FAILURE)).toEqual({
      title: PIN_FAILURE,
    });
  });

  it("keeps several failures apart", () => {
    // Reconnect-all fires one toast per server; each has to be attributable
    // on its own, since they arrive stacked.
    expect(splitServerAttribution("alpha", "Connection refused").title).toBe(
      "alpha",
    );
    expect(splitServerAttribution("beta", "Connection refused").title).toBe(
      "beta",
    );
  });

  it("degrades quietly with no server name", () => {
    expect(splitServerAttribution("", "Connection refused")).toEqual({
      title: "Connection refused",
    });
  });

  it("still says something when the failure carries no message", () => {
    // The dropped preamble ("Failed to connect to X:") used to guarantee the
    // toast had words in it. An Error with an empty message no longer gets
    // one for free.
    expect(splitServerAttribution("alpha", "  ")).toEqual({ title: "alpha" });
    expect(splitServerAttribution("", "")).toEqual({
      title: "Connection failed",
    });
  });

  it("trims, so the title never lands on leading whitespace", () => {
    expect(splitServerAttribution("alpha", "  Connection refused  ")).toEqual({
      title: "alpha",
      description: "Connection refused",
    });
  });
});

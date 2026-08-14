import { describe, expect, it } from "vitest";
import { attributeToServer } from "../server-error-copy";

const PIN_FAILURE =
  'MCP server "champions" doesn\'t support MCP protocol version 2026-07-28, which this client is pinned to.';

describe("attributeToServer", () => {
  it("names the server on a generic failure", () => {
    // The regression this exists to prevent: dropping the route's preamble
    // left "Connection refused" with nothing saying which server refused.
    expect(attributeToServer("champions", "Connection refused")).toBe(
      "champions: Connection refused",
    );
  });

  it("does not repeat a name the message already carries", () => {
    // The stutter the preamble caused, in the other direction. The SDK's
    // pinned-version error opens with the server name, so prefixing it would
    // read "champions: MCP server "champions" doesn't support …".
    expect(attributeToServer("champions", PIN_FAILURE)).toBe(PIN_FAILURE);
  });

  it("keeps several failures apart", () => {
    // Reconnect-all fires one toast per server; each has to be attributable
    // on its own, since they arrive stacked.
    expect(attributeToServer("alpha", "Connection refused")).toBe(
      "alpha: Connection refused",
    );
    expect(attributeToServer("beta", "Connection refused")).toBe(
      "beta: Connection refused",
    );
  });

  it("degrades quietly with no server name", () => {
    expect(attributeToServer("", "Connection refused")).toBe(
      "Connection refused",
    );
  });

  it("trims, so the prefix never lands on leading whitespace", () => {
    expect(attributeToServer("alpha", "  Connection refused  ")).toBe(
      "alpha: Connection refused",
    );
  });
});

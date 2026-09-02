import { describe, expect, it } from "vitest";
import {
  attributeToServer,
  splitServerAttribution,
} from "../server-error-copy";

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

describe("splitServerAttribution", () => {
  it("gives the toast a title and a description instead of a colon splice", () => {
    // "champions: Connection refused" put the server and the failure in one
    // run-on line, with the error icon aligned against the middle of it.
    expect(splitServerAttribution("champions", "Connection refused")).toEqual({
      title: "champions",
      description: "Connection refused",
    });
  });

  it("leaves a message that already names the server on one line", () => {
    // Splitting here would print the name twice: once as the title, once
    // inside the sentence.
    expect(splitServerAttribution("champions", PIN_FAILURE)).toEqual({
      title: PIN_FAILURE,
    });
  });

  it("degrades quietly with no server name", () => {
    expect(splitServerAttribution("", "Connection refused")).toEqual({
      title: "Connection refused",
    });
  });

  it("trims both halves", () => {
    expect(splitServerAttribution("alpha", "  Connection refused  ")).toEqual({
      title: "alpha",
      description: "Connection refused",
    });
  });

  it("splits exactly what attributeToServer joins", () => {
    // The toast shows the split form; Copy writes the joined one. They must
    // describe the same failure.
    const split = splitServerAttribution("alpha", "Connection refused");
    expect(
      split.description ? `${split.title}: ${split.description}` : split.title,
    ).toBe(attributeToServer("alpha", "Connection refused"));
  });
});

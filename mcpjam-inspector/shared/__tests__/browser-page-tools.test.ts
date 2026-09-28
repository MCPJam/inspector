/**
 * The daemon's `webmcp_tools` observation → what the Tools pane lists.
 *
 * This mapping is the whole reason the pane can claim to show what the MODEL
 * would be told: both read the same observation. The cases below are the ones
 * where being wrong is invisible — a page that offers nothing must be an
 * ANSWER rather than an error, and a malformed entry must be dropped rather
 * than listed as a tool nothing can call.
 */
import { describe, expect, it } from "vitest";
import { pageToolsFromObservation } from "../browser-page-tools";

describe("pageToolsFromObservation", () => {
  it("reads a page's tools, with the fields the pane renders", () => {
    const result = pageToolsFromObservation({
      url: "https://webmcp.dev/",
      webmcpSupported: true,
      tools: [
        {
          name: "bookSlot",
          description: "Reserve a 30-minute consultation",
          inputSchema: { type: "object", properties: { date: {} } },
          annotations: { readOnly: false },
          origin: "https://webmcp.dev",
          isMainFrame: true,
          registrationKind: "imperative",
        },
      ],
      // The model's half of the same observation. Not the pane's business, and
      // a screenshot rendered into a tool list would be a 100 KB surprise.
      screenshot: "iVBORdata",
      stateToken: { tabId: "@session", navCounter: 3 },
    });

    expect(result).toEqual({
      ok: true,
      url: "https://webmcp.dev/",
      webmcpSupported: true,
      tools: [
        {
          name: "bookSlot",
          description: "Reserve a 30-minute consultation",
          inputSchema: { type: "object", properties: { date: {} } },
          annotations: { readOnly: false },
          origin: "https://webmcp.dev",
          isMainFrame: true,
          registrationKind: "imperative",
        },
      ],
    });
  });

  it("treats a page with no tools as an answer, not a failure", () => {
    // Most pages offer none. A pane that showed an error here would report a
    // browser working exactly as designed as broken.
    const result = pageToolsFromObservation({
      url: "https://example.com/",
      webmcpSupported: false,
      tools: [],
    });
    expect(result.ok).toBe(true);
    expect(result.webmcpSupported).toBe(false);
    expect(result.tools).toEqual([]);
  });

  it("gives every tool a description, even when the page gave none", () => {
    // Non-optional on the type precisely so each consumer does not invent its
    // own placeholder for the same absent value.
    const result = pageToolsFromObservation({
      tools: [{ name: "cancelBooking" }],
    });
    expect(result.tools).toEqual([{ name: "cancelBooking", description: "" }]);
  });

  it("drops entries that cannot be invoked", () => {
    // `browser_webmcp_invoke` resolves BY NAME. A nameless entry listed in the
    // pane would be an offer nothing can fulfil.
    const result = pageToolsFromObservation({
      tools: [{ description: "no name" }, { name: "   " }, { name: "real" }, 7],
    });
    expect(result.tools.map((t) => t.name)).toEqual(["real"]);
  });

  it("survives an observation that is not the shape we expect", () => {
    for (const output of [null, undefined, "boom", 42, { tools: "nope" }]) {
      const result = pageToolsFromObservation(output);
      expect(result.ok).toBe(true);
      expect(result.tools).toEqual([]);
      expect(result.url).toBe("");
    }
  });

  it("infers support from the list when the daemon did not say", () => {
    // An older daemon answers tools without the flag. Reporting "this page
    // doesn't use WebMCP" above a list of its WebMCP tools is worse than
    // inferring.
    const result = pageToolsFromObservation({ tools: [{ name: "a" }] });
    expect(result.webmcpSupported).toBe(true);
  });
});

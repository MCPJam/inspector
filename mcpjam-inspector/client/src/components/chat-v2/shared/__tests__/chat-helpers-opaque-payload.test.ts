import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../chat-helpers";

// A gateway 502 as it actually arrives: the AI SDK throws
// `new Error(await response.text())`, so an entire HTML document lands in
// `error.message` and used to render verbatim into the chat.
const CLOUDFLARE_502 = `<!DOCTYPE html>
<html lang="en">
<head>
<title>502 Bad Gateway</title>
<meta charset="UTF-8" />
<style>body { margin: 0; padding: 500px; font-size: 404px; }</style>
</head>
<body>
<h1>502 Bad Gateway</h1>
<p>The web server reported a bad gateway error.</p>
<div class="cf-error-details">Ray ID: 8f2a1b3c4d5e6789 &bull; 2026-08-10 21:00:00 UTC</div>
</body>
</html>`;

describe("formatErrorMessage — opaque upstream payloads", () => {
  it("summarizes an HTML error page instead of rendering it", () => {
    const formatted = formatErrorMessage(new Error(CLOUDFLARE_502));

    expect(formatted).not.toBeNull();
    expect(formatted!.message).toBe(
      "The request failed with HTTP 502. An upstream service returned an error page instead of a response.",
    );
    // The message must be short enough to read, not a document.
    expect(formatted!.message.length).toBeLessThan(200);
    expect(formatted!.message).not.toContain("<");
  });

  it("keeps the original payload for the details collapsible", () => {
    const formatted = formatErrorMessage(new Error(CLOUDFLARE_502));

    expect(formatted!.details).toContain("Ray ID: 8f2a1b3c4d5e6789");
  });

  it("reads the status from the title, not from any number in the document", () => {
    // The stylesheet above contains `500` and `404`. A whole-document scan
    // would report one of those as the HTTP status.
    const formatted = formatErrorMessage(new Error(CLOUDFLARE_502));

    expect(formatted!.statusCode).toBe(502);
  });

  it("detects a page that never reaches a closing html tag", () => {
    // Comment-prefixed and truncated: no doctype, no `<html>`, no `</html>`.
    // Matching only the document's opening or closing tag let this render as
    // raw markup — the exact failure this function exists to prevent.
    const formatted = formatErrorMessage(
      new Error(
        "<!-- gateway --><head><title>502 Bad Gateway</title></head><body><h1>502 Bad",
      ),
    );

    expect(formatted!.message).toBe(
      "The request failed with HTTP 502. An upstream service returned an error page instead of a response.",
    );
    expect(formatted!.message).not.toContain("<");
    expect(formatted!.statusCode).toBe(502);
  });

  it("detects a page behind an XML declaration", () => {
    const formatted = formatErrorMessage(
      new Error(
        '<?xml version="1.0" encoding="UTF-8"?><html><head><title>503 Service Unavailable</title></head></html>',
      ),
    );

    expect(formatted!.statusCode).toBe(503);
    expect(formatted!.message).not.toContain("<");
  });

  it("falls back to the h1 when the title carries no status", () => {
    // nginx and several CDNs ship a generic title over a status-bearing h1.
    // Preferring whichever heading merely exists threw the status away.
    const formatted = formatErrorMessage(
      new Error(
        "<!DOCTYPE html><html><head><title>Error</title></head><body><h1>503 Service Unavailable</h1></body></html>",
      ),
    );

    expect(formatted!.statusCode).toBe(503);
    expect(formatted!.message).toBe(
      "The request failed with HTTP 503. An upstream service returned an error page instead of a response.",
    );
  });

  it("summarizes AND truncates a large error page", () => {
    // The production shape: both paths at once, which the separate
    // summarization and truncation cases never exercised together.
    const large = `<!DOCTYPE html><html><head><title>504 Gateway Timeout</title></head><body>${"filler ".repeat(1000)}</body></html>`;
    const formatted = formatErrorMessage(new Error(large));

    expect(formatted!.statusCode).toBe(504);
    expect(formatted!.message).toBe(
      "The request failed with HTTP 504. An upstream service returned an error page instead of a response.",
    );
    expect(formatted!.details!.length).toBeLessThanOrEqual(4001);
    expect(formatted!.details!.endsWith("…")).toBe(true);
  });

  it("does not mistake prose that mentions a tag for a document", () => {
    const message = "Schema mismatch: expected <html> but the tool returned a number";
    const formatted = formatErrorMessage(new Error(message));

    expect(formatted).toEqual({ message });
  });

  it("still summarizes an error page whose status is not in the title", () => {
    const formatted = formatErrorMessage(
      new Error("<html><body><p>upstream unavailable</p></body></html>"),
    );

    expect(formatted!.message).toBe(
      "The request failed. An upstream service returned an error page instead of a response.",
    );
    expect(formatted!.statusCode).toBeUndefined();
    expect(formatted!.details).toContain("upstream unavailable");
  });

  it("truncates a payload too large to keep whole", () => {
    const formatted = formatErrorMessage(new Error("x".repeat(12000)));

    expect(formatted!.message.length).toBeLessThan(500);
    expect(formatted!.details!.length).toBeLessThanOrEqual(4001);
    expect(formatted!.details!.endsWith("…")).toBe(true);
  });
});

describe("formatErrorMessage — ordinary errors are untouched", () => {
  it("passes a plain message through verbatim", () => {
    const formatted = formatErrorMessage(new Error("Tool call failed"));

    expect(formatted).toEqual({ message: "Tool call failed" });
  });

  it("leaves structured JSON errors alone", () => {
    const formatted = formatErrorMessage(
      JSON.stringify({
        error: "Upstream server rejected the call",
        code: "tool_failed",
        details: "stack trace here",
      }),
    );

    expect(formatted!.message).toBe("Upstream server rejected the call");
    expect(formatted!.code).toBe("tool_failed");
    expect(formatted!.details).toBe("stack trace here");
  });

  it("does not summarize a long-ish message that still fits inline", () => {
    const message = `Connection failed: ${"detail ".repeat(20)}`.trim();
    const formatted = formatErrorMessage(new Error(message));

    expect(formatted).toEqual({ message });
  });

  it("returns null for no error", () => {
    expect(formatErrorMessage(null)).toBeNull();
    expect(formatErrorMessage(undefined)).toBeNull();
  });
});

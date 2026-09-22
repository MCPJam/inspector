import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBox } from "../error";
import {
  formatErrorMessage,
  UPSTREAM_ERROR_PAGE_CODE,
} from "../shared/chat-helpers";

/**
 * The Cloudflare interstitial as it was pasted into a User Testing transcript
 * (SUTB-31), trimmed only of repeated markup: doctype, inline styles, the
 * three-column verdict table, and the datacentre/ray footer.
 */
const CLOUDFLARE_502_PAGE = `<!DOCTYPE html>
<html lang="en-US">
<head>
<title>app.mcpjam.com | 502: Bad gateway</title>
<meta charset="UTF-8" />
<style>#cf-wrapper { padding: 500px; font-size: 404px; }</style>
</head>
<body>
<h1><span class="cf-error-type">Error</span><span class="cf-error-code">502</span></h1>
<h2 class="cf-subheadline">Bad gateway</h2>
<div class="cf-status-item"><span>Browser</span><span>Working</span></div>
<div class="cf-status-item"><span>San Jose</span><span>Working</span></div>
<div class="cf-status-item"><span>app.mcpjam.com</span><span>Error</span></div>
<div class="cf-footer-item">Ray ID: <code>9d1f2e3a4b5c6d7e</code> &bull; 2026-08-11 22:15:54 UTC</div>
</body>
</html>`;

/**
 * Stub the chat fetch the way it actually failed, and hand the result to the
 * client the way the AI SDK does.
 *
 * The SDK turns a non-ok response into `new Error(await response.text())`, so
 * the Response object — and with it the status, the content type, the request
 * id — is gone by the time the chat surface sees anything. Everything the
 * banner can know arrives as that one string, which is why this test starts
 * from a real `Response` rather than from a hand-written message: the string
 * the surface receives has to be the one the transport produces.
 */
async function errorFromStubbedHtml502(): Promise<Error> {
  const chatFetch = vi.fn().mockResolvedValue(
    new Response(CLOUDFLARE_502_PAGE, {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/html; charset=UTF-8" },
    })
  );

  const response = await chatFetch("/api/mcp/chat", { method: "POST" });
  expect(response.ok).toBe(false);
  return new Error(await response.text());
}

describe("chat banner for an upstream HTML 502", () => {
  it("renders a short human message and no markup from the page", async () => {
    const formatted = formatErrorMessage(await errorFromStubbedHtml502());

    const { container } = render(
      <ErrorBox
        message={formatted!.message}
        errorDetails={formatted!.details}
        code={formatted!.code}
        statusCode={formatted!.statusCode}
        isRetryable={formatted!.isRetryable}
        onRetry={vi.fn()}
        onResetChat={vi.fn()}
      />
    );

    expect(
      screen.getByText(/MCPJam was briefly unreachable/i)
    ).toBeInTheDocument();

    // Expanded, because "More details" is where the page source actually
    // landed: the banner headline was already a summary before this fix.
    await userEvent.click(screen.getByText("More details"));

    // Nothing from the page reaches the transcript — not the doctype, not the
    // Cloudflare class names, not its status table, not its headline. The
    // stylesheet's `404`/`500` would also have been read as the HTTP status by
    // a whole-document scan, so assert the page's own text is simply absent.
    const rendered = container.textContent ?? "";
    expect(rendered).not.toContain("<");
    expect(rendered).not.toMatch(/doctype/i);
    expect(rendered).not.toContain("cf-error");
    expect(rendered).not.toContain("Bad gateway");
    expect(rendered).not.toContain("San Jose");

    // Positive half of the same assertion: the collapsible is genuinely open
    // and carries the developer detail, so "no markup" is not passing merely
    // because nothing rendered.
    expect(rendered).toContain("9d1f2e3a4b5c6d7e");
    expect(rendered).toContain("502");
  });

  it("offers a retry beside the reset, so the session survives the blip", async () => {
    const onRetry = vi.fn();
    const onResetChat = vi.fn();
    const formatted = formatErrorMessage(await errorFromStubbedHtml502());

    // The surface gates the retry on this code (see `canRetryLastMessage` in
    // ChatTabV2); without it the banner offered `Reset chat` alone, which on
    // the User Testing surface discards the data the session existed to
    // collect.
    expect(formatted!.code).toBe(UPSTREAM_ERROR_PAGE_CODE);

    render(
      <ErrorBox
        message={formatted!.message}
        errorDetails={formatted!.details}
        code={formatted!.code}
        statusCode={formatted!.statusCode}
        isRetryable={formatted!.isRetryable}
        onRetry={onRetry}
        onResetChat={onResetChat}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onResetChat).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Reset chat" })
    ).toBeInTheDocument();
  });

  it("keeps status and request id as the developer detail", async () => {
    const formatted = formatErrorMessage(await errorFromStubbedHtml502());

    expect(JSON.parse(formatted!.details!)).toEqual({
      upstreamResponse: "Error page (HTML body discarded)",
      status: 502,
      requestId: "9d1f2e3a4b5c6d7e",
    });
  });
});

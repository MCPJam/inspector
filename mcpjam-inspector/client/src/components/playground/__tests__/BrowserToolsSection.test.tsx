/**
 * The Tools pane's browser section — the fix for a panel that said "No server
 * connected yet" while the model was driving a real Chromium.
 *
 * Two things it must keep straight, because getting either wrong is a lie the
 * user acts on:
 *
 *   1. OURS vs THE PAGE'S. `browser_*` are tools the model calls by name; the
 *      page's WebMCP tools are reached through `browser_webmcp_invoke`. Shown
 *      as one list, a person would try to make the model call `bookSlot`.
 *   2. WHOSE BROWSER. "this machine" and "your computer" are different
 *      promises about what a click can reach.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BrowserToolsSection } from "../BrowserToolsSection";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";

const TOOLS: SerializedModelRequestTool[] = [
  {
    name: "browser_navigate",
    description: "Open a URL in the browser.",
    inputSchema: { type: "object" },
  },
  {
    name: "browser_webmcp_tools",
    description: "List the WebMCP tools the current page offers.",
    inputSchema: { type: "object" },
  },
];

const PAGE_OK = {
  ok: true as const,
  url: "https://webmcp.dev/",
  webmcpSupported: true,
  tools: [
    { name: "bookSlot", description: "Reserve a 30-minute consultation" },
    {
      name: "getAvailability",
      description: "List bookable times",
      annotations: { readOnly: true },
    },
  ],
};

function renderSection(
  over: Partial<Parameters<typeof BrowserToolsSection>[0]> = {},
) {
  const onRefreshPage = vi.fn();
  render(
    <BrowserToolsSection
      tools={TOOLS}
      page={PAGE_OK}
      engine="hosted"
      searchQuery=""
      onRefreshPage={onRefreshPage}
      {...over}
    />,
  );
  return { onRefreshPage };
}

describe("BrowserToolsSection", () => {
  it("lists the browser tools the model is given", () => {
    renderSection();
    expect(screen.getByText("browser_navigate")).toBeInTheDocument();
    expect(screen.getByText("browser_webmcp_tools")).toBeInTheDocument();
    expect(screen.getByText("Open a URL in the browser.")).toBeInTheDocument();
  });

  it("lists the page's tools separately, and says how they are called", () => {
    renderSection();
    expect(screen.getByText("Page tools")).toBeInTheDocument();
    expect(screen.getByText("bookSlot")).toBeInTheDocument();
    expect(screen.getByText("getAvailability")).toBeInTheDocument();
    // The distinction that stops someone asking the model to call `bookSlot`.
    expect(screen.getByText(/browser_webmcp_invoke/)).toBeInTheDocument();
  });

  it("says whose browser this is", () => {
    renderSection({ engine: "local" });
    expect(screen.getByText("this machine")).toBeInTheDocument();
  });

  it("names the hosted browser as the user's computer", () => {
    renderSection({ engine: "hosted" });
    expect(screen.getByText("your computer")).toBeInTheDocument();
  });

  it("offers no Run — driving a browser goes through approval", () => {
    // Every other section here has one. This must not: a form that fired
    // `browser_act` would drive a signed-in browser outside the approval path
    // that exists to put a person in front of exactly that.
    renderSection();
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
  });

  it("says a page offers nothing, rather than showing an error", () => {
    // The common case. Most pages have no WebMCP at all.
    renderSection({
      page: {
        ok: true,
        url: "https://example.com/",
        webmcpSupported: false,
        tools: [],
      },
    });
    expect(
      screen.getByText("This page doesn't use WebMCP."),
    ).toBeInTheDocument();
  });

  it("names each reason a page could not be read", () => {
    const cases = [
      ["no_browser_session", /No browser running yet/],
      ["no_page", /hasn't loaded a page yet/],
      ["lease_held", /taken control/],
      ["busy", /busy/],
      ["unreachable", /Couldn't read/],
    ] as const;
    for (const [error, copy] of cases) {
      const { unmount } = render(
        <BrowserToolsSection
          tools={TOOLS}
          page={{ ok: false, error }}
          engine="hosted"
          searchQuery=""
          onRefreshPage={vi.fn()}
        />,
      );
      expect(screen.getByText(copy), error).toBeInTheDocument();
      // The browser tools stay listed whatever the page is doing: they are a
      // property of the HOST, not of what happens to be loaded.
      expect(screen.getByText("browser_navigate")).toBeInTheDocument();
      unmount();
    }
  });

  it("stays quiet while the first read is in flight", () => {
    // `null` is "still asking". Flashing "no browser running" at a browser
    // that is starting is the wrong answer, briefly, every single time.
    renderSection({ page: null });
    expect(screen.getByText("Reading the page…")).toBeInTheDocument();
    expect(screen.queryByText(/No browser running yet/)).toBeNull();
  });

  it("renders nothing when the host has no browser", () => {
    renderSection({ tools: [], page: null });
    expect(screen.queryByTestId("browser-tools-section")).toBeNull();
  });

  it("filters both groups with the panel's search box", () => {
    renderSection({ searchQuery: "bookslot" });
    expect(screen.getByText("bookSlot")).toBeInTheDocument();
    expect(screen.queryByText("browser_navigate")).toBeNull();
    expect(screen.queryByText("getAvailability")).toBeNull();
  });

  it("searches descriptions too, not just names", () => {
    // A person looking for what a page can DO types the verb, not the
    // camelCase identifier the page happened to register.
    renderSection({ searchQuery: "consultation" });
    expect(screen.getByText("bookSlot")).toBeInTheDocument();
    expect(screen.queryByText("getAvailability")).toBeNull();
  });

  it("hides the whole section when a search matches nothing in it", () => {
    renderSection({ searchQuery: "zzz-nothing" });
    expect(screen.queryByTestId("browser-tools-section")).toBeNull();
  });

  it("re-reads the page on request", () => {
    // The page changes under the list every time the agent navigates, and
    // nothing pushes that to the client.
    const { onRefreshPage } = renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: /refresh page tools/i }),
    );
    expect(onRefreshPage).toHaveBeenCalledTimes(1);
  });
});

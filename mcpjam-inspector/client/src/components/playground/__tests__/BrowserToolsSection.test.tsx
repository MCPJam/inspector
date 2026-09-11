/**
 * The Tools pane's browser section — the fix for a panel that said "No server
 * connected yet" while the model was driving a real Chromium.
 *
 * Two things it must keep straight, because getting either wrong is a lie the
 * user acts on:
 *
 *   1. OURS vs THE PAGE'S, as sibling groups. A page tool leads with the
 *      page's name (`bookSlot`); the model name and host sit beneath it. The
 *      names must be the ones the SERVER minted, not a second guess.
 *   2. The browser verbs stay listed even when the page has no tools.
 */
import { describe, expect, it, vi } from "vitest";
import { WEBMCP_MAX_PAGE_TOOLS } from "@/shared/declared-tools";
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
  {
    // PRESENT ON PURPOSE, so the assertion that the page-tool section does not
    // point at it can actually fail. A name absent from the fixture can never
    // be rendered, and a `queryByText` for one is a check that passes whatever
    // the component does.
    name: "browser_webmcp_invoke",
    description: "Call a WebMCP tool on the current page by name.",
    inputSchema: { type: "object" },
  },
];

const PAGE_OK = {
  ok: true as const,
  url: "https://webmcp.dev/",
  webmcpSupported: true,
  tools: [
    {
      name: "bookSlot",
      description: "Reserve a 30-minute consultation",
      origin: "https://webmcp.dev",
      isMainFrame: true,
      frameId: "frame-main",
      registrationSeq: 1,
    },
    {
      name: "getAvailability",
      description: "List bookable times",
      origin: "https://webmcp.dev",
      isMainFrame: true,
      frameId: "frame-main",
      registrationSeq: 1,
      annotations: { readOnly: true },
    },
  ],
};

function renderSection(
  over: Partial<Parameters<typeof BrowserToolsSection>[0]> = {},
) {
  const onSelect = vi.fn();
  render(
    <BrowserToolsSection
      tools={TOOLS}
      page={PAGE_OK}
      searchQuery=""
      onSelect={onSelect}
      {...over}
    />,
  );
  return { onSelect };
}

describe("BrowserToolsSection", () => {
  function openBrowser() {
    fireEvent.click(screen.getByRole("button", { name: /^browser$/i }));
  }

  it("starts Browser collapsed — WebMCP is the one that changes", () => {
    renderSection();
    expect(screen.getByText("WebMCP")).toBeInTheDocument();
    expect(screen.getByText("bookSlot")).toBeInTheDocument();
    expect(screen.getByText("Browser")).toBeInTheDocument();
    expect(screen.queryByText("browser_navigate")).toBeNull();
  });

  it("lists the browser tools the model is given", () => {
    renderSection();
    openBrowser();
    expect(screen.getByText("browser_navigate")).toBeInTheDocument();
    expect(screen.getByText("browser_webmcp_tools")).toBeInTheDocument();
    expect(screen.getByText("Open a URL in the browser.")).toBeInTheDocument();
  });

  it("shows a page tool under the page's name, with the model name and host beneath", () => {
    renderSection();
    expect(screen.getByText("WebMCP")).toBeInTheDocument();
    expect(screen.getByText("bookSlot")).toBeInTheDocument();
    expect(screen.getByText("getAvailability")).toBeInTheDocument();
    expect(
      screen.getByText(/webmcp_bookSlot · webmcp\.dev/),
    ).toBeInTheDocument();
  });

  it("collapses WebMCP when the header is clicked", () => {
    renderSection();
    expect(screen.getByText("bookSlot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^webmcp$/i }));
    expect(screen.queryByText("bookSlot")).toBeNull();
    expect(screen.getByText("Browser")).toBeInTheDocument();
  });

  it("puts WebMCP above Browser", () => {
    renderSection();
    const page = screen.getByText("WebMCP");
    const browser = screen.getByText("Browser");
    expect(
      page.compareDocumentPosition(browser) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("webmcp.dev")).toBeNull();
  });

  it("marks the page tools past the cap as NOT offered to the model", async () => {
    // The server advertises at most `WEBMCP_MAX_PAGE_TOOLS`. A pane that
    // listed every declaration under a footer saying the model can call them
    // would lie about the run — and a page with a huge registry is exactly
    // when somebody opens this pane to find out what happened.
    const many = Array.from({ length: WEBMCP_MAX_PAGE_TOOLS + 2 }, (_u, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      origin: "https://webmcp.dev",
      isMainFrame: true,
      frameId: "frame-main",
      registrationSeq: i + 1,
      inputSchema: { type: "object", properties: {} },
    }));
    renderSection({ page: { ok: true, tools: many } as never });
    const notOffered = await screen.findAllByText(/Not offered to the model/);
    // Exactly the overflow, not one more and not one fewer.
    expect(notOffered).toHaveLength(2);
  });

  it("says the model calls them by name, not through a generic verb", () => {
    renderSection();
    expect(
      screen.getByText(/Available to the model on its next step, by these names/),
    ).toBeInTheDocument();
    // THE INSTRUCTION ITSELF, not the whole pane. `browser_webmcp_invoke` is a
    // browser verb and belongs in the verb list above; the claim here is that
    // the sentence introducing the page's tools names THEM rather than routing
    // the model through the generic verb. A pane-wide `queryByText` cannot
    // express that — and with the verb absent from the fixture, as it was, it
    // could not have failed either way.
    expect(
      screen.getByText(
        /Available to the model on its next step, by these names/,
      ).textContent,
    ).not.toContain("browser_webmcp_invoke");
  });

  it("shows the page's read-only claim AS a claim", () => {
    // The approval classifier ignores page annotations entirely (an imperative
    // registration cannot carry them at all), so the badge must not read as a
    // statement of fact about what the tool does.
    renderSection();
    expect(screen.getByText("page says read-only")).toBeInTheDocument();
  });

  it("says when a tool was not offered to the model, and why", () => {
    renderSection({
      page: {
        ok: true,
        url: "https://webmcp.dev/",
        webmcpSupported: true,
        tools: [
          {
            name: "weird",
            description: "",
            // A schema no provider can express as tool arguments.
            inputSchema: { type: "string" },
          },
        ],
      },
    });
    expect(screen.getByText(/Not offered to the model/)).toBeInTheDocument();
  });

  it("offers no Run — driving a browser goes through approval", () => {
    // The section itself still has no Run. Selecting a row opens the panel
    // detail, and Run there asks the agent — it must not fire `browser_act`
    // from this list.
    renderSection();
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
  });

  it("selects a page tool the way an MCP tool row does", () => {
    const { onSelect } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /bookSlot/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.stringContaining("webmcp_bookSlot"),
    );
  });

  it("selects a browser verb the way an MCP tool row does", () => {
    const { onSelect } = renderSection();
    openBrowser();
    fireEvent.click(screen.getByRole("button", { name: /browser_navigate/i }));
    expect(onSelect).toHaveBeenCalledWith("browser:browser_navigate");
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
          searchQuery=""
        />,
      );
      expect(screen.getByText(copy), error).toBeInTheDocument();
      // The browser group stays listed whatever the page is doing: the verbs
      // are a property of the HOST, not of what happens to be loaded.
      expect(screen.getByText("Browser")).toBeInTheDocument();
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
    expect(screen.getByText(/webmcp_bookSlot/)).toBeInTheDocument();
    expect(screen.queryByText("browser_navigate")).toBeNull();
    expect(screen.queryByText("Browser")).toBeNull();
    expect(screen.queryByText("getAvailability")).toBeNull();
  });

  it("searches descriptions too, not just names", () => {
    // A person looking for what a page can DO types the verb, not the
    // camelCase identifier the page happened to register.
    renderSection({ searchQuery: "consultation" });
    expect(screen.getByText("bookSlot")).toBeInTheDocument();
    expect(screen.getByText(/webmcp_bookSlot/)).toBeInTheDocument();
    expect(screen.queryByText("getAvailability")).toBeNull();
  });

  it("hides the whole section when a search matches nothing in it", () => {
    renderSection({ searchQuery: "zzz-nothing" });
    expect(screen.queryByTestId("browser-tools-section")).toBeNull();
  });

});

/**
 * The Tools pane's browser section — the fix for a panel that said "No server
 * connected yet" while the model was driving a real Chromium.
 *
 * Two things it must keep straight, because getting either wrong is a lie the
 * user acts on:
 *
 *   1. OURS vs THE PAGE'S, and — for a page tool — BOTH ITS NAMES. The model
 *      calls `webmcp_bookSlot`; the page calls it `bookSlot`. A pane showing
 *      only one of them makes the transcript unreadable in one direction, and
 *      the names must be the ones the SERVER minted, not a second guess.
 *   2. WHOSE BROWSER. "this machine" and "your computer" are different
 *      promises about what a click can reach.
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

  it("shows a page tool under the name the MODEL calls, with the page's own beneath", () => {
    renderSection();
    expect(screen.getByText("Declared by the page")).toBeInTheDocument();
    // The name in the transcript.
    expect(screen.getByText("webmcp_bookSlot")).toBeInTheDocument();
    expect(screen.getByText("webmcp_getAvailability")).toBeInTheDocument();
    // And the name on the page, with where it came from.
    expect(screen.getByText(/bookSlot · webmcp\.dev/)).toBeInTheDocument();
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

  it("marks the list live only when the browser is reporting changes", () => {
    renderSection({ live: { revision: 4, hash: "abc", count: 2 } });
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("does not claim to be live with no stream open", () => {
    // Absent means "no news" — a daemon too old to send it, or no pane open —
    // never "no tools", and never a promise the list is following the page.
    renderSection();
    expect(screen.queryByText("live")).toBeNull();
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
    expect(screen.getByText("webmcp_bookSlot")).toBeInTheDocument();
    expect(screen.queryByText("browser_navigate")).toBeNull();
    expect(screen.queryByText("webmcp_getAvailability")).toBeNull();
  });

  it("searches descriptions too, not just names", () => {
    // A person looking for what a page can DO types the verb, not the
    // camelCase identifier the page happened to register.
    renderSection({ searchQuery: "consultation" });
    expect(screen.getByText("webmcp_bookSlot")).toBeInTheDocument();
    expect(screen.queryByText("webmcp_getAvailability")).toBeNull();
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

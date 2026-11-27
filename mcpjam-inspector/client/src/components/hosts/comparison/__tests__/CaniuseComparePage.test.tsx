import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, MemoryRouter, Route, Routes } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";
import { AnnouncementQueueProvider, useAnnouncementSlot } from "@/components/announcement-slot";
import { CaniuseComparePage } from "../CaniuseComparePage";

const { captureSnapshot } = vi.hoisted(() => ({ captureSnapshot: vi.fn() }));
vi.mock("@/lib/webmcp/use-surface-agent-bridge", () => ({
  useSurfaceAgentBridge: ({ snapshot }: { snapshot: () => unknown }) => {
    captureSnapshot(snapshot());
  },
}));

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  return { useHostCatalog: () => ({ catalog: bundledHostCompatCatalog() }) };
});

describe("CaniuseComparePage", () => {
  it("plays the intro only on the initial Compare load", () => {
    vi.useFakeTimers();
    try {
      function EarlierAnnouncement({ active }: { active: boolean }) {
        const { open } = useAnnouncementSlot(active);
        return open ? <p>Earlier announcement</p> : null;
      }
      function TestPage({ announcement }: { announcement: boolean }) {
        return (
          <AnnouncementQueueProvider>
            <EarlierAnnouncement active={announcement} />
            <MemoryRouter initialEntries={["/compare"]}>
              <Routes>
                <Route path="/compare" element={<CaniuseComparePage />} />
                <Route
                  path="/capabilities/:slug"
                  element={<Link to="/compare">Back to Compare</Link>}
                />
              </Routes>
            </MemoryRouter>
          </AnnouncementQueueProvider>
        );
      }
      const { rerender } = render(<TestPage announcement />);
      const matrixSearch = () =>
        screen.getByRole("combobox", { name: "Search capabilities" });
      expect(screen.getByText("Earlier announcement")).toBeVisible();
      expect(screen.queryByText("elicitation", { exact: true, selector: ".caniuse-prompt span" })).toBeNull();
      rerender(<TestPage announcement={false} />);
      expect(screen.getByText("elicitation", { exact: true, selector: ".caniuse-prompt span" })).toBeVisible();
      expect(matrixSearch()).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Skip intro" })).toBeNull();
      act(() => vi.advanceTimersByTime(1400));
      expect(screen.getByText("MCP Apps", { exact: true, selector: ".caniuse-prompt span" })).toBeVisible();
      fireEvent.focus(matrixSearch());
      expect(document.querySelector(".caniuse-intro")).toBeNull();
      expect(matrixSearch()).toBeVisible();
      fireEvent.click(screen.getByRole("link", { name: "Capabilities" }));
      fireEvent.click(screen.getByRole("link", { name: "Back to Compare" }));
      expect(matrixSearch()).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("qualifies the Events score with the probed-client denominator", () => {
    render(
      <MemoryRouter initialEntries={["/compare?capability=event-delivery"]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    const score = screen.getByRole("link", { name: /^\d+%, \d+ of \d+ probed clients/ });
    const adoptionHeader = screen.getByRole("columnheader", {
      name: "Client adoption",
    });
    expect(screen.getAllByRole("columnheader")[1]).toBe(adoptionHeader);
    expect(score.closest("tr")?.children[1]).toContainElement(score);
    expect(score).toHaveTextContent(/\d+\/\d+/);
    expect(score).toHaveTextContent(/\d+ with no published result/);
    expect(score).toHaveAttribute("href", "/capabilities/event-delivery");
    const modes = screen.getByRole("group", { name: "Adoption by mode" });
    expect(score.closest("td")).toContainElement(modes);
    expect(within(modes).getAllByRole("link").map((link) => link.getAttribute("href")))
      .toEqual(["poll", "push", "webhook"].map((slice) => `/capabilities/event-delivery?slice=${slice}`));
    expect(score).toHaveAttribute(
      "title",
      expect.stringMatching(
        /probed clients have confirmed support for at least one delivery mode/,
      ),
    );
  });

  it("stacks the selected clients and preserves Events adoption links on mobile", () => {
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
    try {
      render(
        <MemoryRouter initialEntries={["/compare?capability=event-delivery"]}>
          <CaniuseComparePage />
        </MemoryRouter>,
      );
      const matrix = within(screen.getByTestId("compare-matrix"));
      const events = within(matrix.getByRole("article", { name: "MCP Events" }));
      expect(matrix.queryByRole("table")).not.toBeInTheDocument();
      const rows = events.getAllByRole("listitem");
      expect(rows).toHaveLength(3);
      for (const [index, client] of ["Claude", "ChatGPT", "Cursor"].entries()) {
        expect(rows[index]).toHaveTextContent(client);
        expect(rows[index].querySelector("[data-support-level]")).toBeInTheDocument();
        const date = rows[index].querySelector("time");
        expect(date).toHaveAttribute("datetime", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
        expect(date?.querySelector(".whitespace-nowrap")).toHaveTextContent(
          /^\d{4}-\d{2}-\d{2}$/,
        );
      }
      expect(events.getByRole("link", { name: /^\d+%, \d+ of \d+ probed clients/ }))
        .toHaveAttribute("href", "/capabilities/event-delivery");
      const modes = within(events.getByRole("group", { name: "Adoption by mode" }));
      expect(modes.getByRole("link", { name: /^webhook:/i }))
        .toHaveAttribute("href", "/capabilities/event-delivery?slice=webhook");
    } finally {
      width.mockRestore();
    }
  });

  it("shows the share URL when direct clipboard access is blocked", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Clipboard access denied", "NotAllowedError"),
    );
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      render(
        <MemoryRouter initialEntries={["/compare?q=Events"]}>
          <CaniuseComparePage />
        </MemoryRouter>,
      );
      await user.click(screen.getByRole("button", { name: "Copy comparison link" }));
      const link = await screen.findByRole("textbox", { name: "Shareable link" });
      expect(link).toHaveValue(writeText.mock.calls[0][0]);
      expect(debug).toHaveBeenCalledWith("Comparison link clipboard write failed");
    } finally {
      writeText.mockRestore();
      debug.mockRestore();
    }
  });

  it("dismisses hero suggestions without clearing or selecting a capability", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/compare?q="]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    const search = screen.getByRole("combobox", { name: "Type a capability" });
    await user.type(search, "Events");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await user.keyboard("{Escape}{Enter}");
    expect(search).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option")).toBeNull();
    expect(search).toHaveValue("Events");
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("keeps both search fields in sync between rapid keystrokes", () => {
    const router = createMemoryRouter(
      [{ path: "/compare", element: <CaniuseComparePage /> }],
      { initialEntries: ["/compare?hosts=preset:claude"] },
    );
    render(<RouterProvider router={router} />);
    const hero = screen.getByRole<HTMLInputElement>("combobox", {
      name: "Type a capability",
    });
    const toolbar = screen.getByRole<HTMLInputElement>("combobox", {
      name: "Search capabilities",
    });

    act(() => {
      for (const character of "Events") {
        fireEvent.change(hero, { target: { value: hero.value + character } });
      }
      expect(toolbar).toHaveValue("Events");
    });

    expect(hero).toHaveValue("Events");
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("q")).toBe("Events");
    expect(params.get("hosts")).toBe("preset:claude");
  });

  it("shows the first match when reopening scrolled suggestions from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/compare?q=resource"]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    const search = screen.getByRole("combobox", { name: "Type a capability" });
    await user.click(search);
    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", options[1].id);
    listbox.scrollTop = 120;
    await user.keyboard("{Escape}");
    expect(search).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(screen.getByRole("listbox").scrollTop).toBe(0);
  });

  it("copies the exact comparison on the first click and hides gated verification", async () => {
    const query = "toolResult.content.image";
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(
      <MemoryRouter initialEntries={[`/compare?hosts=preset:claude-code&q=${query}`]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Claude Code" })).toBeNull();
    const share = screen.getByRole("button", { name: "Copy comparison link" });
    const heading = screen.getByRole("heading", { name: "Capability matrix" });
    expect(heading.nextElementSibling).toBe(share);
    expect(share).toHaveTextContent(/^$/);
    await user.click(share);
    expect(await within(share).findByText("Link copied")).toHaveClass("sr-only");
    expect(screen.queryByRole("dialog")).toBeNull();
    const params = new URL(writeText.mock.calls[0][0]).searchParams;
    expect(params.get("q")).toBe(query);
    expect(params.get("hosts")).toBe("preset:claude-code");
    writeText.mockRestore();
  });

  it("opens a pinned comparison, keeps adoption stable when clients change, and allows removing the last client", () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/compare?hosts=preset%3Aclaude%2Cpreset%3Acursor&capability=elicitation",
        ]}
      >
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    const search = screen.getByRole("combobox", {
      name: "Search capabilities",
    });
    expect(search).toHaveValue("Elicitation");
    expect(screen.getByRole("link", { name: "By MCPJam" })).toHaveAttribute(
      "href",
      "https://www.mcpjam.com/",
    );
    expect(
      screen.getByRole("button", { name: "Replace Claude" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Replace Cursor" }),
    ).toBeInTheDocument();
    const adoption = () =>
      within(screen.getByRole("table"))
        .getAllByRole("link", { name: /^\d+%, \d+ of \d+ probed clients/ })
        .find(
          (link) => link.getAttribute("href") === "/capabilities/elicitation",
        );
    expect(adoption()).toBeInTheDocument();
    const original = adoption()?.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Remove Claude" }));
    expect(adoption()).toHaveTextContent(original ?? "");
    fireEvent.click(screen.getByRole("button", { name: "Remove Cursor" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add client" }),
    ).toBeInTheDocument();
  });

  it("includes the displayed protocol date in the comparison snapshot", () => {
    render(
      <MemoryRouter initialEntries={["/compare?q=2026-07-28"]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    const version = screen.getByRole("link", { name: "2026-07-28" });
    expect(version).toHaveAttribute(
      "href",
      "/capabilities/supported-protocol-versions?slice=2026-07-28",
    );
    const adoption = within(screen.getByRole("row", { name: /^2026-07-28/ })).getByRole("link", {
      name: /^\d+%, \d+ of \d+ probed clients/,
    });
    expect(adoption).toHaveTextContent(/\d+\/\d+/);
    expect(adoption).toHaveAttribute(
      "href",
      "/capabilities/supported-protocol-versions?slice=2026-07-28",
    );
    expect(captureSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capabilityRows: expect.arrayContaining(["2026-07-28"]),
      }),
    );
  });

  it("keeps a removed client out when the search changes in the same update", () => {
    render(
      <MemoryRouter initialEntries={["/compare?hosts=preset:claude,preset:cursor"]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    const search = screen.getByRole("combobox", { name: "Search capabilities" });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Claude" }));
      fireEvent.change(search, { target: { value: "Events" } });
    });

    expect(search).toHaveValue("Events");
    expect(screen.queryByRole("button", { name: "Replace Claude" })).toBeNull();
    expect(screen.getByRole("button", { name: "Replace Cursor" })).toBeVisible();
  });
});

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  AnnouncementQueueProvider,
  useAnnouncementSlot,
} from "@/components/announcement-slot";
import { CaniuseComparePage } from "../CaniuseComparePage";

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  return { useHostCatalog: () => ({ catalog: bundledHostCompatCatalog() }) };
});

describe("CaniuseComparePage", () => {
  it("waits for the announcement slot before showing the skippable intro", () => {
    function PriorAnnouncement() {
      const [eligible, setEligible] = useState(true);
      const { open } = useAnnouncementSlot(eligible);
      return open ? (
        <button onClick={() => setEligible(false)}>Dismiss announcement</button>
      ) : null;
    }

    render(
      <MemoryRouter initialEntries={["/compare"]}>
        <AnnouncementQueueProvider>
          <PriorAnnouncement />
          <CaniuseComparePage />
        </AnnouncementQueueProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "Skip intro" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss announcement" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip intro" }));
    expect(
      screen.getByRole("combobox", { name: "Search capabilities" }),
    ).toBeVisible();
  });

  it("qualifies the Events score with its published-results denominator", () => {
    render(
      <MemoryRouter initialEntries={["/compare?capability=event-delivery"]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    const score = screen.getByRole("link", { name: /% of \d+ with results/ });
    expect(score).toHaveAttribute(
      "title",
      expect.stringMatching(
        /clients with published results support at least one delivery mode/,
      ),
    );
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
    expect(screen.queryByRole("link", { name: /Verify Claude Code/ })).toBeNull();
    const share = screen.getByRole("button", { name: "Share" });
    const heading = screen.getByRole("heading", { name: "Capability matrix" });
    expect(heading.nextElementSibling).toBe(share);
    expect(share).toHaveTextContent(/^$/);
    await user.click(share);
    expect(await screen.findByText("Link copied")).toHaveClass("sr-only");
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
        .getAllByRole("link", { name: /% adoption/ })
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

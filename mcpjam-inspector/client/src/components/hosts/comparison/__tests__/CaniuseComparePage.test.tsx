import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("shares the exact field query and hides verification for gated clients", () => {
    const query = "toolResult.content.image";
    render(
      <MemoryRouter initialEntries={[`/compare?hosts=preset:claude-code&q=${query}`]}>
        <CaniuseComparePage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /Verify Claude Code/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Shareable link" });
    expect(new URL(input.value).searchParams.get("q")).toBe(query);
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
});

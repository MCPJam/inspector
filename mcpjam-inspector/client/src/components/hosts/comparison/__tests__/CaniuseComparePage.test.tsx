import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CaniuseComparePage } from "../CaniuseComparePage";

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  return { useHostCatalog: () => ({ catalog: bundledHostCompatCatalog() }) };
});

describe("CaniuseComparePage", () => {
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

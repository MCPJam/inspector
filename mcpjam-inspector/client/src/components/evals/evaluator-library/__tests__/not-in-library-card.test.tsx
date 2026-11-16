import { describe, expect, it, vi } from "vitest";
import { Server } from "lucide-react";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { NotInLibraryCard } from "../not-in-library-card";

describe("NotInLibraryCard", () => {
  it("lists what lives elsewhere and links to it", () => {
    const onAction = vi.fn();
    renderWithProviders(
      <NotInLibraryCard
        icon={Server}
        title="Server checks"
        description="Grade the server. Run once per deploy."
        items={["Tool catalog review", "Security probes"]}
        actionLabel="Server checks"
        onAction={onAction}
      />,
    );
    const section = screen.getByRole("region", { name: "Server checks" });
    expect(section).toHaveTextContent("Tool catalog review");
    expect(section).toHaveTextContent("Security probes");
    fireEvent.click(screen.getByRole("button", { name: "Server checks" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

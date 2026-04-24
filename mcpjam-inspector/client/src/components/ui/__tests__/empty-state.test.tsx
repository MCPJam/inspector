import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

describe("EmptyState", () => {
  it("renders title, description, and optional helper", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="Nothing here"
        description="Add something to get started."
        helperText="Tip: use the button above."
        className="h-auto"
      />,
    );

    expect(screen.getByRole("heading", { name: "Nothing here" })).toBeInTheDocument();
    expect(
      screen.getByText("Add something to get started."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tip: use the button above."),
    ).toBeInTheDocument();
  });

  it("does not force description onto one line (allows wrapping)", () => {
    const { container } = render(
      <EmptyState
        icon={Inbox}
        title="T"
        description="One two three four five six seven."
        className="h-auto"
      />,
    );

    const description = container.querySelector("p.text-sm.text-muted-foreground");
    expect(description).not.toBeNull();
    expect(description?.className).not.toMatch(/whitespace-nowrap/);
  });

  it("renders children below the description inside the content block", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="Empty"
        description="Do something."
        className="h-auto"
      >
        <button type="button">Go</button>
      </EmptyState>,
    );

    const region = screen.getByRole("heading", { name: "Empty" }).parentElement;
    expect(region?.querySelector("button")).not.toBeNull();
    expect(region).toContainElement(screen.getByRole("button", { name: "Go" }));
  });
});

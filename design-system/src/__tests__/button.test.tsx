// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { Button } from "../components/button";

afterEach(cleanup);

describe("Button contrast variant", () => {
  it("pairs card roles and preserves a visible keyboard outline", () => {
    render(<Button variant="contrast">Review Team upgrade</Button>);

    expect(screen.getByRole("button")).toHaveClass(
      "bg-card-foreground",
      "text-card",
      "border-card-foreground",
      "hover:bg-foreground",
      "focus-visible:outline-solid",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-4",
      "focus-visible:outline-card-foreground",
    );
    expect(screen.getByRole("button")).not.toHaveClass("bg-primary");
  });

  it("preserves link semantics and permits wrapping in narrow containers", () => {
    render(
      <Button asChild variant="contrast" className="h-auto whitespace-normal">
        <a href="/organizations/org/plans">Review Team upgrade</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Review Team upgrade" });
    expect(link).toHaveAttribute("href", "/organizations/org/plans");
    expect(link).toHaveClass("whitespace-normal", "h-auto");
    expect(link).not.toHaveClass("whitespace-nowrap");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

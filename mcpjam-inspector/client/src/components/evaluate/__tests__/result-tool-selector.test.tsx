import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CheckRow } from "@/components/evals/checks-section";
import { blankPredicate } from "@/shared/predicate-kinds";

const kinds = ["toolResultContains", "toolResultMatches"] as const;

describe.each(kinds)("%s tool selector", (type) => {
  it("keeps a dropdown available before tools load and preserves a saved tool", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CheckRow
        embedded
        paper
        predicate={{ ...blankPredicate(type), toolName: "saved_tool" }}
        onChange={onChange}
        availableTools={[]}
      />,
    );
    const selector = screen.getByRole("combobox", { name: "Tool" });
    expect(selector).toHaveTextContent("saved_tool");
    await user.click(selector);
    expect(screen.getByRole("option", { name: "saved_tool" })).toBeVisible();
    await user.click(
      screen.getByRole("option", {
        name: type === "toolResultMatches" ? "Any tool" : "All tools",
      }),
    );
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("toolName");
  });

  it("lets the user select an available tool", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CheckRow
        embedded
        paper
        predicate={blankPredicate(type)}
        onChange={onChange}
        availableTools={["show-squad"]}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Tool" }));
    await user.click(screen.getByRole("option", { name: "show-squad" }));
    expect(onChange.mock.lastCall?.[0]).toMatchObject({
      toolName: "show-squad",
    });
  });

  it("disables selection in a read-only case", () => {
    const onChange = vi.fn();
    render(
      <CheckRow
        embedded
        paper
        readOnly
        predicate={blankPredicate(type)}
        onChange={onChange}
        availableTools={[]}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Tool" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

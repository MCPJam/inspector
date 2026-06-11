import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BuiltInToolCheckboxList } from "../BuiltInToolCheckboxList";
import type { BuiltInToolCatalogEntry } from "@/hooks/useBuiltInToolCatalog";

const WEB_SEARCH: BuiltInToolCatalogEntry = {
  id: "web_search",
  displayLabel: "Web Search",
  description: "Search the web",
  category: "search",
  billable: true,
};

const BASH: BuiltInToolCatalogEntry = {
  id: "bash",
  displayLabel: "Bash",
  description: "Run shell commands",
  category: "code",
  billable: false,
  requiresComputer: true,
};

function checkboxFor(container: HTMLElement, label: string): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll("label"));
  const match = labels.find((l) => l.textContent?.includes(label));
  if (!match) throw new Error(`no checkbox row for "${label}"`);
  return match.querySelector("input[type=checkbox]") as HTMLInputElement;
}

describe("BuiltInToolCheckboxList — computer gating", () => {
  it("disables a requiresComputer tool when no computer is attached", () => {
    const onChange = vi.fn();
    const { container, getByText } = render(
      <BuiltInToolCheckboxList
        label="Built-in tools"
        selected={[]}
        available={[WEB_SEARCH, BASH]}
        computerAttached={false}
        onChange={onChange}
      />
    );

    expect(checkboxFor(container, "Web Search").disabled).toBe(false);
    const bash = checkboxFor(container, "Bash");
    expect(bash.disabled).toBe(true);
    expect(getByText(/Requires a personal computer/i)).toBeTruthy();

    // Clicking the disabled tool does not toggle it on.
    fireEvent.click(bash);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("enables a requiresComputer tool when a computer is attached", () => {
    const onChange = vi.fn();
    const { container } = render(
      <BuiltInToolCheckboxList
        label="Built-in tools"
        selected={[]}
        available={[BASH]}
        computerAttached
        onChange={onChange}
      />
    );

    const bash = checkboxFor(container, "Bash");
    expect(bash.disabled).toBe(false);
    fireEvent.click(bash);
    expect(onChange).toHaveBeenCalledWith(["bash"]);
  });

  it("leaves non-computer tools unaffected by the attachment state", () => {
    const onChange = vi.fn();
    const { container } = render(
      <BuiltInToolCheckboxList
        label="Built-in tools"
        selected={[]}
        available={[WEB_SEARCH]}
        computerAttached={false}
        onChange={onChange}
      />
    );
    fireEvent.click(checkboxFor(container, "Web Search"));
    expect(onChange).toHaveBeenCalledWith(["web_search"]);
  });
});

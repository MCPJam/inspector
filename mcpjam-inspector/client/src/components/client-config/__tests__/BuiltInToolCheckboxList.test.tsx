import { render, fireEvent, screen } from "@testing-library/react";
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
      />,
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
      />,
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
      />,
    );
    fireEvent.click(checkboxFor(container, "Web Search"));
    expect(onChange).toHaveBeenCalledWith(["web_search"]);
  });

  it("keeps a stale selected-but-blocked tool removable (repairs invalid state)", () => {
    // bash already selected with no computer attached: must stay unchecking-
    // able so the user can fix the invalid draft.
    const onChange = vi.fn();
    const { container } = render(
      <BuiltInToolCheckboxList
        label="Built-in tools"
        selected={["bash"]}
        available={[BASH]}
        computerAttached={false}
        onChange={onChange}
      />,
    );
    const bash = checkboxFor(container, "Bash");
    expect(bash.checked).toBe(true);
    expect(bash.disabled).toBe(false); // removable
    fireEvent.click(bash);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("readOnly disables every checkbox and blocks all edits", () => {
    const onChange = vi.fn();
    const { container } = render(
      <BuiltInToolCheckboxList
        label="Built-in tools"
        selected={["web_search"]}
        available={[WEB_SEARCH, BASH]}
        computerAttached
        readOnly
        onChange={onChange}
      />,
    );
    const webSearch = checkboxFor(container, "Web Search");
    const bash = checkboxFor(container, "Bash");
    expect(webSearch.disabled).toBe(true);
    expect(bash.disabled).toBe(true);
    // Even an unchecking action (selected tool) is blocked in read-only mode.
    fireEvent.click(webSearch);
    fireEvent.click(bash);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("minimal variant renders switch rows without descriptions", () => {
    const onChange = vi.fn();
    render(
      <BuiltInToolCheckboxList
        variant="minimal"
        selected={[]}
        available={[WEB_SEARCH, BASH]}
        computerAttached={false}
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "Web Search" }),
    ).not.toBeDisabled();
    expect(screen.getByRole("switch", { name: "Bash" })).toBeDisabled();
    expect(screen.queryByText("Search the web")).toBeNull();
  });

  it("disallows computer-backed tools entirely on eval suites, but stale ones stay removable", () => {
    const onChange = vi.fn();
    const { container, getByText, rerender } = render(
      <BuiltInToolCheckboxList
        label="Built-in tools"
        selected={[]}
        available={[BASH]}
        computerAttached
        computerToolsDisallowed
        onChange={onChange}
      />,
    );
    // Even with a (hypothetical) computer attached, eval disallows it.
    expect(checkboxFor(container, "Bash").disabled).toBe(true);
    expect(getByText(/Not available for eval suites/i)).toBeTruthy();

    // A stale selected one is still removable.
    rerender(
      <BuiltInToolCheckboxList
        label="Built-in tools"
        selected={["bash"]}
        available={[BASH]}
        computerAttached={false}
        computerToolsDisallowed
        onChange={onChange}
      />,
    );
    const bash = checkboxFor(container, "Bash");
    expect(bash.disabled).toBe(false);
    fireEvent.click(bash);
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

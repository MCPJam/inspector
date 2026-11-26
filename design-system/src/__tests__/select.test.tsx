/**
 * `leading` and `trailing` render beside the label in the dropdown row only:
 * the closed trigger mirrors `ItemText`, so neither may end up inside it.
 */
// @vitest-environment jsdom
//
// Per FILE: this package's `tokens-parity` test reads `tokens.css` through
// `import.meta.url`, which jsdom turns into http: and `readFileSync` rejects.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";

// The package has no setup file and no `globals`, so Testing Library cannot
// register its own auto-cleanup. Do it explicitly.
afterEach(cleanup);

describe("SelectItem", () => {
  it("keeps leading and trailing content out of the trigger", () => {
    render(
      <Select value="a" open>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value="a"
            description="Sonnet"
            leading={<img alt="logo" />}
            trailing={<span>2 servers</span>}
          >
            Claude
          </SelectItem>
        </SelectContent>
      </Select>,
    );

    const option = screen.getByRole("option", { name: /Claude/ });
    expect(option).toHaveTextContent("Sonnet");
    expect(option).toHaveTextContent("2 servers");
    expect(option.querySelector("img")).toBeInTheDocument();

    // The open listbox is modal, so the trigger sits behind aria-hidden.
    const trigger = screen.getByRole("combobox", { hidden: true });
    expect(trigger).toHaveTextContent("Claude");
    expect(trigger).not.toHaveTextContent("2 servers");
    expect(trigger.querySelector("img")).toBeNull();
  });
});

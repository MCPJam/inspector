import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SuiteStageChecks } from "../suite-stage-checks";

describe("SuiteStageChecks", () => {
  it("presents the agreed checks as a stage-first table with every check enabled by default", () => {
    render(<SuiteStageChecks onChange={() => {}} />);
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((row) => row.textContent),
    ).toEqual([
      "Connection",
      "Discovery",
      "Selection",
      "Tool call",
      "Tool response",
      "User value",
    ]);
    expect(within(table).getByText("OAuth connection")).toBeTruthy();
    expect(within(table).getByText("Deprecated tools exposed")).toBeTruthy();
    expect(
      within(table).getByText("Tool hops before the right tool"),
    ).toBeTruthy();
    expect(
      within(table).getByText("Input privacy, including user_intent"),
    ).toBeTruthy();
    expect(
      within(table).getByText("Pagination and truncation clarity"),
    ).toBeTruthy();
    expect(within(table).getByText("Efficiency and frustration")).toBeTruthy();
    const checkboxes = within(table).getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(21);
    expect(
      checkboxes.every(
        (checkbox) => checkbox.getAttribute("aria-checked") === "true",
      ),
    ).toBe(true);
    expect(
      screen.queryByText(/planned|not available|groundedness/i),
    ).toBeNull();
  });
});

function EditableChecks({ initial = [] }: { initial?: string[] }) {
  const [disabled, setDisabled] = useState<string[] | undefined>(initial);
  return <SuiteStageChecks disabledChecks={disabled} onChange={setDisabled} />;
}

it("toggles individual checks by label without changing another stage", () => {
  render(<EditableChecks />);
  fireEvent.click(screen.getByText("OAuth connection"));
  expect(
    screen
      .getByRole("checkbox", { name: "OAuth connection" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    screen
      .getByRole("checkbox", { name: "Tool errors (isError)" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByText("OAuth connection"));
  expect(
    screen
      .getByRole("checkbox", { name: "OAuth connection" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

it("loads saved opt-outs and leaves newly added checks on", () => {
  render(<EditableChecks initial={["connection.oauth"]} />);
  expect(
    screen
      .getByRole("checkbox", { name: "OAuth connection" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    screen
      .getByRole("checkbox", { name: "Outcome achieved" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

it("disables editing in read-only mode", () => {
  render(
    <SuiteStageChecks
      readOnly
      onChange={() => {
        throw new Error("read-only edit");
      }}
    />,
  );
  const checkbox = screen.getByRole("checkbox", { name: "OAuth connection" });
  fireEvent.click(checkbox);
  expect(checkbox.hasAttribute("disabled")).toBe(true);
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
});

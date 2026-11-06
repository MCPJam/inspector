import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  toast: Object.assign(vi.fn(), {
    success: (...args: unknown[]) => mocks.success(...args),
    error: (...args: unknown[]) => mocks.error(...args),
  }),
}));

import {
  SuiteCasesCard,
  type AddCaseItem,
  type SuiteCasesCardProps,
} from "../suite-cases-card";
import { ADD_CASE_HINT_DELAY_MS } from "../add-case-menu";

const cases = [
  { caseId: "c1", title: "Draw a rectangle" },
  { caseId: "c2", title: "Untitled test case" },
];
const targets = [
  { suiteId: "s2", name: "Asana SDK ingestion", locked: false },
  { suiteId: "s3", name: "mcpjam-mcp dogfood (production)", locked: true },
];
const items = (overrides: Partial<AddCaseItem> = {}): AddCaseItem[] => [
  {
    label: "Describe",
    description: "Tell us a behavior. Chat drafts the case",
    onSelect: vi.fn(),
  },
  {
    label: "Generate",
    description: "From live discovery of your servers",
    onSelect: vi.fn(),
    ...overrides,
  },
];

function renderCard(props: Partial<SuiteCasesCardProps> = {}) {
  const all: SuiteCasesCardProps = {
    cases,
    addCaseItems: items(),
    copyTargets: targets,
    pendingCopyCaseId: null,
    canDelete: true,
    onOpenCase: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...props,
  };
  render(<SuiteCasesCard {...all} />);
  return all;
}

beforeEach(() => {
  mocks.success.mockReset();
  mocks.error.mockReset();
});

describe("SuiteCasesCard (C-1 to C-10)", () => {
  it("lists titles only and opens a case on click", () => {
    const props = renderCard();
    const card = screen.getByTestId("suite-settings-test-cases");
    expect(within(card).getByText("Test Cases")).toBeTruthy();
    expect(screen.getByTestId("suite-settings-case-row-c1").textContent).toBe(
      "Draw a rectangle",
    );
    expect(screen.getByTestId("suite-settings-case-row-c2").textContent).toBe(
      "Untitled test case",
    );
    fireEvent.click(screen.getByTestId("suite-settings-case-row-c1"));
    expect(props.onOpenCase).toHaveBeenCalledWith("c1");
  });

  it("shows an item's description only after a 2,000 ms hover", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByTestId("suite-settings-add-case"));
    vi.useFakeTimers();
    const describe = screen.getByTestId("suite-settings-add-case-describe");
    fireEvent.mouseEnter(describe);
    act(() => vi.advanceTimersByTime(ADD_CASE_HINT_DELAY_MS - 1));
    expect(
      screen.queryByText("Tell us a behavior. Chat drafts the case"),
    ).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByText("Tell us a behavior. Chat drafts the case"),
    ).toBeTruthy();
    fireEvent.mouseLeave(describe);
    expect(
      screen.queryByText("Tell us a behavior. Chat drafts the case"),
    ).toBeNull();
    vi.useRealTimers();
  });

  it("disables Generate and shows its reason", async () => {
    const user = userEvent.setup();
    renderCard({
      addCaseItems: items({ disabled: true }),
      generateDisabledReason: "Connect b to generate cases for this suite.",
    });
    await user.click(screen.getByTestId("suite-settings-add-case"));
    expect(
      screen
        .getByTestId("suite-settings-add-case-generate")
        .hasAttribute("data-disabled"),
    ).toBe(true);
    expect(
      screen.getByText("Connect b to generate cases for this suite."),
    ).toBeTruthy();
  });

  it("locked: no Add case, the reason instead, delete and copy stay", () => {
    renderCard({
      addCaseItems: null,
      lockedReason:
        "Managed by CI — edit the test file, or duplicate to edit here",
    });
    expect(screen.queryByTestId("suite-settings-add-case")).toBeNull();
    expect(
      screen.getByText(
        "Managed by CI — edit the test file, or duplicate to edit here",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("suite-settings-case-delete-c1")).toBeTruthy();
    expect(screen.getByTestId("suite-settings-case-copy-c1")).toBeTruthy();
  });

  it("deletes through onDelete after the confirm, then toasts", async () => {
    const props = renderCard();
    fireEvent.click(screen.getByTestId("suite-settings-case-delete-c1"));
    expect(
      screen.getByText("Delete “Draw a rectangle”? This cannot be undone."),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("suite-settings-case-delete-confirm"));
    });
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledWith("c1");
    expect(mocks.success).toHaveBeenCalledWith("Test case deleted");
  });

  it("toasts a failed delete", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderCard({ onDelete: vi.fn().mockRejectedValue(new Error("no")) });
    fireEvent.click(screen.getByTestId("suite-settings-case-delete-c1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("suite-settings-case-delete-confirm"));
    });
    expect(mocks.error).toHaveBeenCalledWith("Failed to delete test case");
  });
});

describe("Copy to another suite (P-1 to P-4, P-8)", () => {
  it("labels the button and lists every target, the CI one disabled with its reason", async () => {
    const user = userEvent.setup();
    const props = renderCard();
    const button = screen.getByTestId("suite-settings-case-copy-c1");
    expect(button.getAttribute("aria-label")).toBe(
      "Copy test case: Draw a rectangle",
    );
    await user.click(button);
    const open = screen.getByTestId("suite-settings-copy-target-s2");
    expect(open.textContent).toBe("Copy to Asana SDK ingestion");
    const locked = screen.getByTestId("suite-settings-copy-target-s3");
    expect(locked.hasAttribute("data-disabled")).toBe(true);
    expect(locked.textContent).toBe(
      "Copy to mcpjam-mcp dogfood (production)Runs from CI. Edit its cases in the repo.",
    );
    await user.click(open);
    expect(props.onCopy).toHaveBeenCalledWith("c1", targets[0]);
  });

  it("disables the button with a reason when there is no other suite", async () => {
    const user = userEvent.setup();
    renderCard({ copyTargets: [] });
    const button = screen.getByTestId(
      "suite-settings-case-copy-c1",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.hover(button.parentElement as HTMLElement);
    expect(
      (await screen.findAllByText("No other suite to copy to")).length,
    ).toBeGreaterThan(0);
  });

  it("spins and blocks the pending row's button", () => {
    renderCard({ pendingCopyCaseId: "c1" });
    const pending = screen.getByTestId(
      "suite-settings-case-copy-c1",
    ) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.querySelector(".animate-spin")).toBeTruthy();
    const other = screen.getByTestId(
      "suite-settings-case-copy-c2",
    ) as HTMLButtonElement;
    expect(other.disabled).toBe(false);
  });

  it("hides the copy icon when copyTargets is null", () => {
    renderCard({ copyTargets: null });
    expect(screen.queryByTestId("suite-settings-case-copy-c1")).toBeNull();
  });
});

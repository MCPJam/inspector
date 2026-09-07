import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuiteSettingsRow } from "../suite-settings-row";

describe("SuiteSettingsRow", () => {
  it("keeps collapsed content in the DOM but hidden when collapsible", () => {
    render(
      <SuiteSettingsRow
        settingKey="name"
        collapsible
        chained={false}
        summary="Test Suite"
      >
        <input aria-label="Suite name" defaultValue="Test Suite" />
      </SuiteSettingsRow>,
    );
    const input = document.querySelector('input[aria-label="Suite name"]');
    expect(input).toBeTruthy();
    expect(input?.closest("[hidden]")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Suite name" }),
    ).toBeNull();
  });

  it("shows section content by default without a toggle", () => {
    render(
      <SuiteSettingsRow settingKey="name" chained={false}>
        <input aria-label="Suite name" defaultValue="Test Suite" />
      </SuiteSettingsRow>,
    );
    expect(screen.getByRole("textbox", { name: "Suite name" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("Edit and Close toggle aria-expanded and visibility when collapsible", async () => {
    const user = userEvent.setup();
    render(
      <SuiteSettingsRow
        settingKey="name"
        collapsible
        chained={false}
        summary="Test Suite"
      >
        <input aria-label="Suite name" defaultValue="Test Suite" />
      </SuiteSettingsRow>,
    );
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toHaveAttribute("aria-expanded", "false");
    await user.click(edit);
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Suite name" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("disables inner controls but keeps the trigger working when collapsible", async () => {
    const user = userEvent.setup();
    render(
      <SuiteSettingsRow
        settingKey="computerEnvironment"
        collapsible
        chained={false}
        disabledReason="Not enabled for this organization"
        summary="Unavailable"
      >
        <select aria-label="Computer environment">
          <option>None</option>
        </select>
      </SuiteSettingsRow>,
    );
    const trigger = screen.getByRole("button", { name: "Edit" });
    expect(trigger).not.toBeDisabled();
    await user.click(trigger);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByText("Not enabled for this organization")).toBeTruthy();
  });

  it("shows Applies immediately in the section header", () => {
    render(
      <SuiteSettingsRow
        settingKey="environments"
        chained={false}
        appliesImmediately
      >
        <div data-testid="suite-environment-bar" />
      </SuiteSettingsRow>,
    );
    expect(screen.getByText("Applies immediately")).toBeTruthy();
    expect(
      screen.getByTestId("suite-environment-bar"),
    ).toBeVisible();
  });

  it("shows the error in the header and Fix opens and focuses the invalid control when collapsible", async () => {
    const user = userEvent.setup();
    render(
      <SuiteSettingsRow
        settingKey="name"
        collapsible
        chained={false}
        summary=""
        error={{
          message: "Name is required",
          focusSelector: 'input[aria-label="Suite name"]',
        }}
      >
        <input aria-label="Suite name" aria-invalid="true" />
      </SuiteSettingsRow>,
    );
    expect(screen.getByText("Name is required · Fix")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Name is required/ }));
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Suite name" }),
    );
  });

  it("passes data attributes through", () => {
    const { container } = render(
      <SuiteSettingsRow
        settingKey="name"
        chained={false}
        data-step-id="identity"
      >
        <input aria-label="Suite name" />
      </SuiteSettingsRow>,
    );
    const row = container.querySelector('[data-setting-key="name"]');
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-step-id")).toBe("identity");
  });

  it("uses the manifest label by default", () => {
    render(
      <SuiteSettingsRow settingKey="passOrFail" chained={false}>
        <div>body</div>
      </SuiteSettingsRow>,
    );
    expect(screen.getByRole("heading", { name: "Pass or fail" })).toBeTruthy();
  });

  it("renders hint copy under the section title", () => {
    render(
      <SuiteSettingsRow settingKey="policy" chained={false} hint="How each case is decided.">
        <div>body</div>
      </SuiteSettingsRow>,
    );
    expect(screen.getByText("How each case is decided.")).toBeTruthy();
  });
});

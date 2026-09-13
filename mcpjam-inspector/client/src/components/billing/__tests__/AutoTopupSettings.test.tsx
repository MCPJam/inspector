import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { AutoTopupSettings } from "../AutoTopupSettings";

describe("AutoTopupSettings", () => {
  it("saves a selected preset and validates custom amounts", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    render(<AutoTopupSettings enrollment={null} canManage onSave={save} />);
    await user.click(screen.getByRole("radio", { name: "2,000 credits $20" }));
    await user.click(
      screen.getByRole("button", { name: "Turn on auto-reload" }),
    );
    expect(save).toHaveBeenCalledWith({
      thresholdCredits: 100,
      topupCredits: 2000,
      monthlySpendLimitCredits: null,
    });
    await user.click(screen.getByRole("radio", { name: "Custom amount" }));
    await user.clear(screen.getByLabelText("Credits to add"));
    await user.click(
      screen.getByRole("button", { name: "Turn on auto-reload" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "positive whole number",
    );
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("converts dollar limits and rejects a cap smaller than one reload", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    render(<AutoTopupSettings enrollment={null} canManage onSave={save} />);
    const minimum = screen.getByLabelText("Minimum balance");
    await user.clear(minimum);
    await user.type(minimum, "250");
    const limit = screen.getByLabelText("Maximum monthly spend (optional)");
    await user.type(limit, "2");
    await user.click(
      screen.getByRole("button", { name: "Turn on auto-reload" }),
    );
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("at least one reload");
    await user.clear(limit);
    await user.type(limit, "25");
    await user.click(
      screen.getByRole("button", { name: "Turn on auto-reload" }),
    );
    expect(save).toHaveBeenCalledWith({
      thresholdCredits: 250,
      topupCredits: 500,
      monthlySpendLimitCredits: 2500,
    });
  });
  it("requires reviewing configuration before enrolling", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    render(<AutoTopupSettings enrollment={null} canManage onSave={save} />);
    expect(screen.getByRole("radio", { name: "500 credits $5" })).toBeChecked();
    expect(save).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Turn on auto-reload" }),
    );
    expect(save).toHaveBeenCalledWith({
      thresholdCredits: 100,
      topupCredits: 500,
      monthlySpendLimitCredits: null,
    });
    expect(screen.queryByText("Enrolled")).not.toBeInTheDocument();
  });
  it("shows a compact configuration view for an enrolled organization", () => {
    render(
      <AutoTopupSettings
        enrollment={{ thresholdCredits: 200, topupCredits: 1000 }}
        canManage
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Minimum balance")).toHaveValue(200);
    expect(
      screen.getByRole("radio", { name: "1,000 credits $10" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Enroll here" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
  it("never claims enrollment or saves when the service is unavailable", async () => {
    const user = userEvent.setup();
    render(<AutoTopupSettings canManage />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Turn on auto-reload" }),
    ).toBeDisabled();
  });
  it("keeps member configuration read-only", () => {
    render(
      <AutoTopupSettings
        enrollment={{ thresholdCredits: 100, topupCredits: 500 }}
        canManage={false}
      />,
    );
    expect(
      screen.getByRole("radio", { name: "500 credits $5" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
  });
  it("shows a failed save without claiming enrollment", async () => {
    const user = userEvent.setup();
    render(
      <AutoTopupSettings
        enrollment={null}
        canManage
        onSave={vi.fn().mockRejectedValue(new Error("Please retry"))}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Turn on auto-reload" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Please retry");
    expect(screen.queryByText("Enrolled")).not.toBeInTheDocument();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auto-topup-stripe", () => ({
  mountAutoTopupCard: async () => ({ confirm, destroy: vi.fn() }),
}));
import { AutoTopupCardSetup } from "../AutoTopupCardSetup";
it("finishes backend enrollment only after Stripe confirmation, and surfaces errors", async () => {
  const user = userEvent.setup();
  const finish = vi.fn();
  confirm.mockRejectedValueOnce(new Error("Card declined"));
  render(
    <AutoTopupCardSetup
      setup={{ clientSecret: "secret", setupIntentId: "seti_1" }}
      publishableKey="pk_test_example"
      onFinish={finish}
      onCancel={vi.fn()}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Save card and enable refills",
  });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Card declined");
  expect(finish).not.toHaveBeenCalled();
  confirm.mockResolvedValue(undefined);
  await user.click(button);
  expect(finish).toHaveBeenCalledWith("seti_1");
});

it("retries only backend finish after card setup already succeeded", async () => {
  const user = userEvent.setup();
  confirm.mockReset().mockResolvedValue(undefined);
  const finish = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValue(undefined);
  render(
    <AutoTopupCardSetup
      setup={{ clientSecret: "secret", setupIntentId: "seti_1" }}
      publishableKey="pk_test_example"
      onFinish={finish}
      onCancel={vi.fn()}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Save card and enable refills",
  });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connection interrupted",
  );
  await user.click(button);
  expect(finish).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
});

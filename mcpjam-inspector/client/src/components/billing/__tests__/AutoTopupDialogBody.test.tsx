import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ price: 900, revision: 1, begin: vi.fn() }));
vi.mock("@/hooks/useAutoTopup", () => ({
  useAutoTopup: () => ({
    view: {
      preferences: {
        thresholdCredits: 100,
        topupCredits: 1000,
        monthlySpendLimitCents: 2700,
      },
      revision: state.revision,
      refillPriceCents: state.price,
      status: "not_active",
      eligible: true,
      activationAllowed: true,
    },
    begin: state.begin,
    save: vi.fn(),
    disable: vi.fn(),
    finish: vi.fn(),
  }),
}));
vi.mock("../AutoTopupCardSetup", () => ({
  AutoTopupCardSetup: () => <p>Secure card form</p>,
}));
import { AutoTopupDialogBody } from "../AutoTopupDialogBody";
afterEach(() => {
  vi.unstubAllEnvs();
  state.price = 900;
});
it("revokes unchecked consent when the quote changes without a settings revision", async () => {
  vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "pk_test_example");
  const user = userEvent.setup();
  const { rerender } = render(
    <AutoTopupDialogBody organizationId="a" canManage onClose={vi.fn()} />,
  );
  await user.click(screen.getByLabelText(/I authorize/));
  state.price = 1000;
  rerender(
    <AutoTopupDialogBody organizationId="a" canManage onClose={vi.fn()} />,
  );
  expect(screen.getByLabelText(/I authorize/)).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Continue to card setup" }),
  ).toBeDisabled();
});
it("does not show a setup response from the previous organization", async () => {
  vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "pk_test_example");
  let resolve!: (value: unknown) => void;
  state.begin.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const user = userEvent.setup();
  const { rerender } = render(
    <AutoTopupDialogBody organizationId="a" canManage onClose={vi.fn()} />,
  );
  await user.click(screen.getByLabelText(/I authorize/));
  await user.click(
    screen.getByRole("button", { name: "Continue to card setup" }),
  );
  await waitFor(() => expect(state.begin).toHaveBeenCalled());
  rerender(
    <AutoTopupDialogBody organizationId="b" canManage onClose={vi.fn()} />,
  );
  await act(async () =>
    resolve({ clientSecret: "secret", setupIntentId: "seti_1" }),
  );
  expect(screen.queryByText("Secure card form")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/I authorize/)).not.toBeChecked();
});

it("keeps disable confirmation visible after the backend revision changes", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <AutoTopupDialogBody organizationId="a" canManage onClose={vi.fn()} />,
  );
  await user.click(
    screen.getByRole("button", { name: "Turn off auto-reload" }),
  );
  state.revision += 1;
  rerender(
    <AutoTopupDialogBody organizationId="a" canManage onClose={vi.fn()} />,
  );
  expect(
    screen.getByText(/New automatic purchases are off/),
  ).toBeInTheDocument();
});

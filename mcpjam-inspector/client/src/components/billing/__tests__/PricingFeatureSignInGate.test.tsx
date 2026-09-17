import { render, screen } from "@testing-library/react";
import { it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  flag: false,
  member: false as boolean | undefined,
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => state.flag,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => state.member,
}));
vi.mock("@/components/auth/GuestSignInMessage", () => ({
  GuestSignInMessage: ({ message }: { message: string }) => <p>{message}</p>,
}));
import { PricingFeatureSignInGate } from "../PricingFeatureSignInGate";
it("restricts guest features only on the separate flag and waits for identity", () => {
  const ui = (
    <PricingFeatureSignInGate feature="Evals">
      <p>Eval content</p>
    </PricingFeatureSignInGate>
  );
  const { rerender } = render(ui);
  expect(screen.getByText("Eval content")).toBeInTheDocument();
  state.flag = true;
  rerender(<div>{ui}</div>);
  expect(screen.getByText("Sign in to use Evals.")).toBeInTheDocument();
  state.member = undefined;
  rerender(<section>{ui}</section>);
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  state.member = true;
  rerender(<main>{ui}</main>);
  expect(screen.getByText("Eval content")).toBeInTheDocument();
});

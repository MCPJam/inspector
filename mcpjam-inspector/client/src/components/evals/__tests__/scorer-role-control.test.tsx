import { expect, it } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { RoleChip } from "../scorer-role-control";

it("explains both assertion roles on keyboard focus", async () => {
  renderWithProviders(<RoleChip role="required" />);
  await userEvent.setup().tab();
  const help = await screen.findByRole("tooltip");
  expect(help).toHaveTextContent(
    "Required: If this assertion fails, the iteration fails.",
  );
  expect(help).toHaveTextContent(
    "Advisory: Shown on the result. Never fails the iteration.",
  );
  // The legend names what happens to the test, not what the system does, so
  // the mechanism words must not come back into it.
  expect(help).not.toHaveTextContent(/\bWarn\b|\bReport\b|\bGate\b/);
});

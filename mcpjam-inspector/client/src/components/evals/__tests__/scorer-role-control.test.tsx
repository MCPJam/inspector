import { expect, it } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { RoleChip } from "../scorer-role-control";

it("explains all assertion roles on keyboard focus", async () => {
  renderWithProviders(<RoleChip role="gate" />);
  await userEvent.setup().tab();
  const help = await screen.findByRole("tooltip");
  expect(help).toHaveTextContent(
    "Gate: If this assertion fails, the iteration fails.",
  );
  expect(help).toHaveTextContent(
    "Warn: If this assertion fails, a warning is shown without failing the iteration.",
  );
  expect(help).toHaveTextContent(
    "Report: Records the result for reference without changing the iteration verdict.",
  );
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { DeclaredSchemaFields } from "../declared-schema-fields";

describe("DeclaredSchemaFields", () => {
  const predicate = {
    type: "toolResultMatchesSchema" as const,
    schema: "declared",
  };

  it("explains the check and switches to a written schema", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DeclaredSchemaFields
        predicate={predicate}
        onChange={onChange}
        readOnly={false}
      />,
    );
    expect(
      screen.getByText(/output schema its tool declares/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Write a schema instead" }),
    );
    expect(onChange).toHaveBeenCalledWith({ ...predicate, schema: {} });
  });

  it("offers no switch when read-only", () => {
    renderWithProviders(
      <DeclaredSchemaFields
        predicate={predicate}
        onChange={() => {}}
        readOnly
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

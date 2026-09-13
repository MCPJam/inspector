import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import {
  DataManagementSettings,
  PermissionGroupsDialog,
} from "../EnterpriseSettings";
it.each([false, true])(
  "offers direct contact for enterprise=%s",
  (enterprise) => {
    render(<DataManagementSettings enterprise={enterprise} />);
    expect(screen.getByRole("link", { name: "Contact us" })).toHaveAttribute(
      "href",
      "https://www.mcpjam.com/contact",
    );
  },
);
it("opens a dismissible permission groups upsell", async () => {
  render(<PermissionGroupsDialog enterprise={false} />);
  await userEvent.click(
    screen.getByRole("button", { name: /Permission groups/ }),
  );
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Access custom permission groups with Enterprise",
  );
  expect(screen.getByRole("link", { name: "Contact us" })).toHaveAttribute(
    "href",
    "https://www.mcpjam.com/contact",
  );
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

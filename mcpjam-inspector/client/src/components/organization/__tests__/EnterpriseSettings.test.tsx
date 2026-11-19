import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import { DataManagementSettings } from "../EnterpriseSettings";
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

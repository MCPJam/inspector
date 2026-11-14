import { screen } from "@testing-library/react";
import { expect } from "vitest";

/** Literal URLs, so a wrong value in legal-links.ts fails here too. */
export function expectLegalConsentLinks() {
  expect(screen.getByRole("link", { name: "Terms of Use" })).toHaveAttribute(
    "href",
    "https://www.mcpjam.com/terms-of-use",
  );
  expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
    "href",
    "https://www.mcpjam.com/privacy-policy",
  );
}

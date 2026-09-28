import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalInstallCallout } from "../LocalInstallCallout";
afterEach(() => vi.unstubAllEnvs());
it("shows a local install path for hosted visitors only", () => {
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  const { rerender } = render(<LocalInstallCallout />);
  expect(
    screen.getByRole("link", { name: "Download the desktop app" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/MCPJam/inspector/releases/latest",
  );
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
  rerender(<LocalInstallCallout />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

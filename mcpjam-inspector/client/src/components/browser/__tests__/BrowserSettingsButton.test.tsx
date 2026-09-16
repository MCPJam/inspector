import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigate,
}));

import { BrowserSettingsButton } from "../BrowserSettingsButton";

it("opens the client Browser tab in host focus", () => {
  render(<BrowserSettingsButton hostId="host-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
  expect(navigate).toHaveBeenCalledWith("/hosts/host-1?hostTab=browser");
});

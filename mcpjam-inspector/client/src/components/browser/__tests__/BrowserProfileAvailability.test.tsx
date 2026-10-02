import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";

const availability = vi.hoisted(() => ({ available: true }));

vi.mock("@/lib/browser-profiles/availability", () => ({
  useBrowserProfileArchivesAvailable: () => availability.available,
}));
vi.mock("@/lib/browser-profiles/client", () => ({
  saveBrowserProfile: vi.fn(),
  listBrowserProfiles: vi.fn(async () => []),
  setBrowserProfileDefault: vi.fn(),
  deleteBrowserProfile: vi.fn(),
}));

import { BrowserProfileSaveButton } from "../BrowserProfileSaveButton";
import { BrowserProfilesSettings } from "../BrowserProfilesSettings";

function renderSave() {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <BrowserProfileSaveButton
          projectId="prj_1"
          exportArchive={vi.fn()}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return screen.getByRole("menuitem", { name: /Save profile for other chats/ });
}

describe("saved browser profiles on a server that cannot save or load them", () => {
  beforeEach(() => {
    availability.available = true;
  });

  it("offers Save where profiles can be saved", () => {
    const item = renderSave();

    expect(item).not.toHaveAttribute("data-disabled");
    expect(screen.queryByText("Not available on this server")).toBeNull();
  });

  it("disables Save and says why", () => {
    availability.available = false;

    const item = renderSave();

    expect(item).toHaveAttribute("data-disabled");
    expect(item).toHaveTextContent("Not available on this server");
  });

  it("says so in the project's profile settings", async () => {
    availability.available = false;
    render(<BrowserProfilesSettings projectId="prj_1" />);

    await userEvent.click(screen.getByTestId("browser-profiles-toggle"));

    expect(
      await screen.findByTestId("browser-profiles-unavailable"),
    ).toHaveTextContent("Profiles can't be saved or loaded on this server.");
    expect(screen.queryByText(/Save one from the browser panel/)).toBeNull();
  });

  it("keeps the usual empty state where profiles can be saved", async () => {
    render(<BrowserProfilesSettings projectId="prj_1" />);

    await userEvent.click(screen.getByTestId("browser-profiles-toggle"));

    expect(
      await screen.findByText(/Save one from the browser panel/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("browser-profiles-unavailable")).toBeNull();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateApiKeyDialog } from "../CreateApiKeyDialog";

vi.mock("../../SettingsDraftProvider", () => ({
  useSettingsDraft: () => {},
}));

const onCreate = vi.fn();

function renderDialog() {
  return render(
    <CreateApiKeyDialog
      open
      onOpenChange={vi.fn()}
      isCreating={false}
      organizations={[{ _id: "org-a", name: "Acme" }]}
      orgsLoading={false}
      onCreate={onCreate}
    />,
  );
}

beforeEach(() => {
  onCreate.mockReset().mockResolvedValue(undefined);
});

describe("CreateApiKeyDialog expiry", () => {
  it("creates a key that expires in 90 days unless told otherwise", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(
      screen.getByRole("combobox", { name: "Expires after" }),
    ).toHaveTextContent("90 days");
    await user.type(screen.getByLabelText("Name"), "ci");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: "ci",
        organizationId: "org-a",
        expiresInDays: 90,
      }),
    );
  });

  it("passes the lifetime the user picked", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "laptop");
    await user.click(screen.getByRole("combobox", { name: "Expires after" }));
    await user.click(screen.getByRole("option", { name: "7 days" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ expiresInDays: 7 }),
      ),
    );
  });

  it("offers no option that never expires", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("combobox", { name: "Expires after" }));

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "7 days",
      "30 days",
      "60 days",
      "90 days",
      "180 days",
      "1 year",
    ]);
  });
});

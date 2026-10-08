import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateApiKeyDialog } from "../CreateApiKeyDialog";
import type { ApiKeyMintEligibility } from "@/lib/apis/web/api-keys";

vi.mock("../../SettingsDraftProvider", () => ({
  useSettingsDraft: () => {},
}));

const mockGetApiKeyMintEligibility = vi.fn();
vi.mock("@/lib/apis/web/api-keys", () => ({
  getApiKeyMintEligibility: (...args: unknown[]) =>
    mockGetApiKeyMintEligibility(...args),
}));

const onCreate = vi.fn();

function renderDialog(organizations = [{ _id: "org-a", name: "Acme" }]) {
  return render(
    <CreateApiKeyDialog
      open
      onOpenChange={vi.fn()}
      isCreating={false}
      organizations={organizations}
      orgsLoading={false}
      onCreate={onCreate}
    />,
  );
}

function eligibility(
  mintAllowed: boolean,
  mintMinimumRole: "member" | "admin" = "admin",
): ApiKeyMintEligibility {
  return { mintAllowed, mintMinimumRole };
}

beforeEach(() => {
  onCreate.mockReset().mockResolvedValue(undefined);
  mockGetApiKeyMintEligibility.mockReset().mockResolvedValue(eligibility(true));
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

describe("CreateApiKeyDialog organization setting for who creates keys", () => {
  it("disables creating a key where only owners and admins create keys, and says so", async () => {
    mockGetApiKeyMintEligibility.mockResolvedValue(eligibility(false));
    const user = userEvent.setup();
    renderDialog();

    expect(
      await screen.findByTestId("api-key-create-not-allowed"),
    ).toHaveTextContent(
      "Only its owners and admins can create API keys. Ask one of them to create a key for you, or to allow members to create keys.",
    );
    await user.type(screen.getByLabelText("Name"), "ci{Enter}");

    expect(screen.getByRole("button", { name: "Create key" })).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(mockGetApiKeyMintEligibility).toHaveBeenCalledWith("org-a");
  });

  it("names the role when the organization's floor is member", async () => {
    mockGetApiKeyMintEligibility.mockResolvedValue(
      eligibility(false, "member"),
    );
    renderDialog();

    expect(
      await screen.findByTestId("api-key-create-not-allowed"),
    ).toHaveTextContent(
      "Your role in this organization can't create API keys.",
    );
    expect(screen.getByRole("button", { name: "Create key" })).toBeDisabled();
  });

  it("leaves creating open for someone the organization lets create keys", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(mockGetApiKeyMintEligibility).toHaveBeenCalledWith("org-a"),
    );
    await user.type(screen.getByLabelText("Name"), "ci");

    expect(screen.getByRole("button", { name: "Create key" })).toBeEnabled();
    expect(
      screen.queryByTestId("api-key-create-not-allowed"),
    ).not.toBeInTheDocument();
  });

  it("lets the user try when the check gives no answer", async () => {
    mockGetApiKeyMintEligibility.mockRejectedValue(
      new Error("Request failed (502)"),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(mockGetApiKeyMintEligibility).toHaveBeenCalled(),
    );
    await user.type(screen.getByLabelText("Name"), "ci");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(
      screen.queryByTestId("api-key-create-not-allowed"),
    ).not.toBeInTheDocument();
  });

  it("follows the organization the user picks", async () => {
    mockGetApiKeyMintEligibility.mockImplementation(
      async (organizationId: string) => eligibility(organizationId === "org-a"),
    );
    const user = userEvent.setup();
    renderDialog([
      { _id: "org-a", name: "Acme" },
      { _id: "org-b", name: "Beta" },
    ]);
    await user.type(screen.getByLabelText("Name"), "ci");

    await user.click(screen.getByRole("combobox", { name: "Organization" }));
    await user.click(screen.getByRole("option", { name: "Beta" }));

    expect(
      await screen.findByTestId("api-key-create-not-allowed"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create key" })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Organization" }));
    await user.click(screen.getByRole("option", { name: "Acme" }));

    await waitFor(() =>
      expect(
        screen.queryByTestId("api-key-create-not-allowed"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Create key" })).toBeEnabled();
  });
});

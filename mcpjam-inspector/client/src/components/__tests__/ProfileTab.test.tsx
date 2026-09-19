import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileTab } from "../ProfileTab";
import { AccountApiKeySection } from "../setting/AccountApiKeySection";
const { updateName, updateInfo } = vi.hoisted(() => ({
  updateInfo: vi.fn().mockResolvedValue(undefined),
  updateName: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    signIn: vi.fn(),
  }),
}));
vi.mock("convex/react", () => ({
  useQuery: () => ({ name: "Ada Lovelace" }),
  useAction: () => vi.fn(),
  useMutation: (name: string) =>
    name === "users:updateName"
      ? updateName
      : name === "users:updateInfo"
        ? updateInfo
        : vi.fn(),
}));
vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({ profilePictureUrl: "/avatar.png" }),
}));
describe("Profile settings", () => {
  beforeEach(() => vi.clearAllMocks());
  it("shows the name, email, picture, and accessible photo change control", () => {
    render(<ProfileTab />);
    expect(
      screen.getByRole("heading", { name: "Profile" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "ada@example.com",
    );
    expect(screen.getByLabelText("Email address")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change profile photo" }),
    ).toBeEnabled();
    expect(document.getElementById("settings-content")).toBeInTheDocument();
  });
  it("keeps the existing name-save mutation", async () => {
    render(<ProfileTab />);
    const input = screen.getByPlaceholderText("Enter your name");
    fireEvent.change(input, { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("About me"), {
      target: { value: "Mathematician" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateName).toHaveBeenCalledWith({ name: "Ada" }),
    );
  });
  it("saves about me through the existing mutation", async () => {
    render(<ProfileTab />);
    fireEvent.change(screen.getByLabelText("About me"), {
      target: { value: "Mathematician" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateInfo).toHaveBeenCalledWith({ info: "Mathematician" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Changes saved",
    );
    expect(updateName).not.toHaveBeenCalled();
  });
  it("retains a failed draft for retry", async () => {
    updateName.mockRejectedValueOnce(new Error("Network error"));
    render(<ProfileTab />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save",
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
  it("rejects a blank name", async () => {
    render(<ProfileTab />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter your name",
    );
    expect(updateName).not.toHaveBeenCalled();
  });
  it("offers a real hyperlink with concise retired-key guidance", () => {
    render(<AccountApiKeySection projectId={null} projectName="Demo" />);
    expect(
      screen.getByRole("link", { name: "Manage API keys" }),
    ).toHaveAttribute("href", "/settings/api-keys");
    expect(
      screen.getByText(
        "Project API keys are retired. Use a personal API key for SDK and CI access.",
      ),
    ).toBeInTheDocument();
  });
});

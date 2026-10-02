import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileTab } from "../ProfileTab";
import { AccountApiKeySection } from "../setting/AccountApiKeySection";
import { ImageUploadError } from "@/lib/image-upload";
const { updateName, updateInfo, uploadImage } = vi.hoisted(() => ({
  uploadImage: vi.fn(),
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
vi.mock("@/hooks/useImageUpload", () => ({
  useImageUpload: () => uploadImage,
}));
function choosePhoto(container: HTMLElement, file: File) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
}
describe("Profile settings", () => {
  beforeEach(() => vi.clearAllMocks());
  it("only offers the accepted image types in the file picker", () => {
    const { container } = render(<ProfileTab />);
    expect(container.querySelector('input[type="file"]')).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/gif,image/webp",
    );
    expect(
      screen.getByText("PNG, JPEG, GIF, or WebP, up to 5 MB."),
    ).toBeInTheDocument();
  });
  it.each([
    [
      new File(["text"], "notes.txt", { type: "text/plain" }),
      "Choose a PNG, JPEG, GIF, or WebP image.",
    ],
    [
      new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" }),
      "Choose a PNG, JPEG, GIF, or WebP image.",
    ],
    [
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", {
        type: "image/png",
      }),
      "Choose an image that is 5 MB or smaller.",
    ],
  ])(
    "explains how to correct an unsupported profile image",
    (file, message) => {
      const { container } = render(<ProfileTab />);
      choosePhoto(container, file);
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(uploadImage).not.toHaveBeenCalled();
    },
  );
  it("uploads a supported image through the upload route", async () => {
    uploadImage.mockResolvedValueOnce({ url: "https://files.example/p.png" });
    const photo = new File(["image"], "photo.png", { type: "image/png" });
    const { container } = render(<ProfileTab />);
    choosePhoto(container, photo);
    await waitFor(() =>
      expect(uploadImage).toHaveBeenCalledWith(
        { kind: "profile-picture" },
        photo,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Change profile photo" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("shows the server's reason when it refuses the image", async () => {
    uploadImage.mockRejectedValueOnce(
      new ImageUploadError(
        "Choose a PNG, JPEG, GIF, or WebP image.",
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      ),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = render(<ProfileTab />);
      choosePhoto(
        container,
        new File(["image"], "photo.png", { type: "image/png" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Choose a PNG, JPEG, GIF, or WebP image.",
      );
    } finally {
      log.mockRestore();
    }
  });
  it("offers another upload after a failure", async () => {
    uploadImage.mockRejectedValueOnce(new Error("upload unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = render(<ProfileTab />);
      choosePhoto(
        container,
        new File(["image"], "photo.png", { type: "image/png" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Your profile picture could not be updated. Try uploading it again.",
      );
      expect(
        screen.getByRole("button", { name: "Change profile photo" }),
      ).toBeEnabled();
    } finally {
      log.mockRestore();
    }
  });
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

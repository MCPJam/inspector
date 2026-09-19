import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrganizationGeneralDetails } from "../OrganizationGeneralDetails";
describe("Organization General details", () => {
  const props = {
    name: "Acme",
    canEdit: true,
    isUploading: false,
    onUpload: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
  };
  it("shows labeled details and saves a trimmed name", async () => {
    render(<OrganizationGeneralDetails {...props} />);
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: " New name " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith("New name"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Changes saved",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Upload organization logo" }),
    );
    expect(props.onUpload).toHaveBeenCalled();
  });
  it("makes member details read-only", () => {
    render(<OrganizationGeneralDetails {...props} canEdit={false} />);
    expect(screen.getByLabelText("Organization name")).toHaveAttribute(
      "readonly",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("rejects blank names and keeps failed edits for retry", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Network failure"));
    render(<OrganizationGeneralDetails {...props} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: " " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter an organization name",
    );
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "New name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not save"),
    );
    expect(screen.getByLabelText("Organization name")).toHaveValue("New name");
  });
});

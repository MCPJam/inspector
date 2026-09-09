import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, userEvent } from "@/test";
import { ImportDatasetDialog } from "../import-dataset-dialog";

function makeFile(name: string, type: string, content = "a,b\n1,2") {
  return new File([content], name, { type });
}

describe("ImportDatasetDialog", () => {
  it("renders the upload prompt", () => {
    renderWithProviders(
      <ImportDatasetDialog open onOpenChange={vi.fn()} />,
    );

    expect(screen.getByText("Upload dataset")).toBeInTheDocument();
    expect(screen.getByText("Import data")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /upload a CSV, JSON, or Markdown file/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/up to 5\.0 MB/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/insert data programmatically/i),
    ).not.toBeInTheDocument();
  });

  it("does nothing when closed", () => {
    renderWithProviders(
      <ImportDatasetDialog open={false} onOpenChange={vi.fn()} />,
    );
    expect(screen.queryByText("Upload dataset")).not.toBeInTheDocument();
  });

  it("accepts a valid CSV file via the hidden input and shows it selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ImportDatasetDialog open onOpenChange={vi.fn()} />,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile("cases.csv", "text/csv");
    await user.upload(input, file);

    expect(await screen.findByText("cases.csv")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import/i })).not.toBeDisabled();
  });

  it("rejects an unsupported file type", async () => {
    renderWithProviders(
      <ImportDatasetDialog open onOpenChange={vi.fn()} />,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile("notes.txt", "text/plain", "hello");
    // userEvent.upload respects the input's `accept` filter and would refuse
    // to select a .txt file; fireEvent bypasses that to exercise the
    // component's own extension check.
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      await screen.findByText(/only csv, json, or markdown files/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import/i })).toBeDisabled();
  });

  it("rejects a file over the size cap", async () => {
    renderWithProviders(
      <ImportDatasetDialog open onOpenChange={vi.fn()} />,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const oversized = makeFile("huge.csv", "text/csv", "x");
    Object.defineProperty(oversized, "size", { value: 6 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [oversized] } });

    expect(
      await screen.findByText(/file is too large/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import/i })).toBeDisabled();
  });

  it("accepts a Markdown file", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ImportDatasetDialog open onOpenChange={vi.fn()} />,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile("cases.md", "text/markdown", "# cases");
    await user.upload(input, file);

    expect(await screen.findByText("cases.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import/i })).not.toBeDisabled();
  });

  it("calls onImport with the selected file", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ImportDatasetDialog
        open
        onOpenChange={onOpenChange}
        onImport={onImport}
      />,
    );

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = makeFile("cases.json", "application/json", "[]");
    await user.upload(input, file);

    await user.click(screen.getByRole("button", { name: /import/i }));

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0][0].name).toBe("cases.json");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

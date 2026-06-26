import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import { ExportTracesModal } from "../export-traces-modal";

const { exportSession, exportProject, mockDownload } = vi.hoisted(() => ({
  exportSession: vi.fn(),
  exportProject: vi.fn(),
  mockDownload: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useAction: (name: string) =>
    name.includes("exportSessionTraces") ? exportSession : exportProject,
}));

vi.mock("@/lib/download-text-file", () => ({
  downloadTextFile: (...args: unknown[]) => mockDownload(...args),
}));

function lastDownloadBody(): { resourceSpans: unknown[] } {
  const call = mockDownload.mock.calls.at(-1)!;
  return JSON.parse(call[1] as string);
}

describe("ExportTracesModal", () => {
  beforeEach(() => {
    exportSession.mockReset();
    exportProject.mockReset();
    mockDownload.mockReset();
  });

  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    projectId: "proj_1",
    runChatSessionIds: ["cs_a", "cs_b"],
  };

  it("defaults to this-run, redacted; downloads OTLP JSON", async () => {
    exportSession.mockResolvedValue({ resourceSpans: [{ resource: {} }] });
    renderWithProviders(<ExportTracesModal {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => expect(exportSession).toHaveBeenCalledTimes(1));
    expect(exportSession).toHaveBeenCalledWith({
      projectId: "proj_1",
      chatSessionIds: ["cs_a", "cs_b"],
      includeContent: false, // redacted by default
    });
    expect(exportProject).not.toHaveBeenCalled();
    const [filename, , mime] = mockDownload.mock.calls.at(-1)!;
    expect(String(filename)).toMatch(/\.json$/);
    expect(mime).toBe("application/json");
    expect(lastDownloadBody().resourceSpans).toHaveLength(1);
  });

  it("include-content checkbox opts in", async () => {
    exportSession.mockResolvedValue({ resourceSpans: [] });
    renderWithProviders(<ExportTracesModal {...baseProps} />);

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => expect(exportSession).toHaveBeenCalledTimes(1));
    expect(exportSession.mock.calls[0][0].includeContent).toBe(true);
  });

  it("whole-project scope paginates and concatenates", async () => {
    exportProject
      .mockResolvedValueOnce({
        resourceSpans: [{ a: 1 }],
        nextCursor: "c1",
        isDone: false,
      })
      .mockResolvedValueOnce({
        resourceSpans: [{ a: 2 }],
        nextCursor: null,
        isDone: true,
      });
    renderWithProviders(<ExportTracesModal {...baseProps} />);

    await userEvent.click(
      screen.getByRole("radio", { name: /whole project/i })
    );
    await userEvent.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => expect(exportProject).toHaveBeenCalledTimes(2));
    expect(exportProject.mock.calls[0][0].cursor).toBeNull();
    expect(exportProject.mock.calls[1][0].cursor).toBe("c1");
    expect(exportSession).not.toHaveBeenCalled();
    expect(lastDownloadBody().resourceSpans).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("disables this-run when the run has no recorded sessions", async () => {
    exportProject.mockResolvedValue({
      resourceSpans: [],
      nextCursor: null,
      isDone: true,
    });
    renderWithProviders(
      <ExportTracesModal {...baseProps} runChatSessionIds={[]} />
    );

    expect(screen.getByRole("radio", { name: /this run/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /download/i }));
    // falls back to whole-project
    await waitFor(() => expect(exportProject).toHaveBeenCalled());
    expect(exportSession).not.toHaveBeenCalled();
  });
});

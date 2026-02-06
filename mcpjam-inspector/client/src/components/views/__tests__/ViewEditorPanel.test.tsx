import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ViewEditorPanel } from "../ViewEditorPanel";

const flushPendingValidationMock = vi.fn<() => boolean>();

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => {
    props.onRegisterFlushPendingValidation?.(flushPendingValidationMock);

    return (
      <div data-testid="json-editor-mock">
        {props.toolbarRightContent}
        <button
          type="button"
          data-testid="mark-dirty"
          onClick={() => props.onDirtyChange?.(true)}
        >
          mark-dirty
        </button>
      </div>
    );
  },
}));

function createView() {
  return {
    _id: "view-1",
    name: "Capital View",
    protocol: "mcp-apps",
    toolName: "capitals-explore-capitals",
    toolInput: { name: "Paris" },
  } as any;
}

describe("ViewEditorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flushPendingValidationMock.mockReturnValue(true);
  });

  it("flushes pending validation before run and blocks run when invalid", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);

    render(
      <ViewEditorPanel
        view={createView()}
        onBack={() => {}}
        onRun={onRun}
        serverConnectionStatus="connected"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(onRun).toHaveBeenCalledTimes(1);
    });

    expect(flushPendingValidationMock).toHaveBeenCalledTimes(1);
    expect(flushPendingValidationMock.mock.invocationCallOrder[0]).toBeLessThan(
      onRun.mock.invocationCallOrder[0],
    );

    flushPendingValidationMock.mockReturnValue(false);
    onRun.mockClear();
    toastErrorMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(flushPendingValidationMock).toHaveBeenCalledTimes(2);
    });
    expect(onRun).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "JSON is invalid. Fix errors before running.",
    );
  });

  it("flushes pending validation before save and blocks save when invalid", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <ViewEditorPanel
        view={createView()}
        onBack={() => {}}
        onSave={onSave}
        hasUnsavedChanges={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(flushPendingValidationMock).toHaveBeenCalledTimes(1);
    expect(flushPendingValidationMock.mock.invocationCallOrder[0]).toBeLessThan(
      onSave.mock.invocationCallOrder[0],
    );

    flushPendingValidationMock.mockReturnValue(false);
    onSave.mockClear();
    toastErrorMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(flushPendingValidationMock).toHaveBeenCalledTimes(2);
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "JSON is invalid. Fix errors before saving.",
    );
  });

  it("enables save when editor reports dirty even if parent unsaved flag is false", async () => {
    render(
      <ViewEditorPanel
        view={createView()}
        onBack={() => {}}
        onSave={vi.fn().mockResolvedValue(undefined)}
        hasUnsavedChanges={false}
      />,
    );

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    fireEvent.click(screen.getByTestId("mark-dirty"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });
  });
});

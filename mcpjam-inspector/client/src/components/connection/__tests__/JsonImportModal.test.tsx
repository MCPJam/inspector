import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JsonImportModal } from "../JsonImportModal";
import { parseJsonConfig, validateJsonConfig } from "@/lib/json-config-parser";

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("@/lib/json-config-parser", () => ({
  parseJsonConfig: vi.fn(),
  validateJsonConfig: vi.fn(),
}));

let flushIsValid = true;
const flushPendingValidationMock = vi.fn(() => flushIsValid);

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => {
    props.onRegisterFlushPendingValidation?.(flushPendingValidationMock);
    return (
      <textarea
        data-testid="json-editor-input"
        value={props.rawContent ?? ""}
        onChange={(event) => props.onRawChange?.(event.target.value)}
        onBlur={() => props.onValidationError?.(null)}
      />
    );
  },
}));

describe("JsonImportModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flushIsValid = true;
    (parseJsonConfig as Mock).mockReturnValue([
      {
        name: "weather",
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: {},
      },
    ]);
    (validateJsonConfig as Mock).mockReturnValue({ success: true });
  });

  it("does not run full config validation on every raw content change", () => {
    render(
      <JsonImportModal isOpen={true} onClose={vi.fn()} onImport={vi.fn()} />,
    );

    const textarea = screen.getByTestId("json-editor-input");
    fireEvent.change(textarea, {
      target: {
        value: `{"mcpServers":{"x":{"command":"${"a".repeat(9000)}"}}}`,
      },
    });

    expect(validateJsonConfig).not.toHaveBeenCalled();
  });

  it("flushes pending validation before import and blocks when JSON is invalid", async () => {
    flushIsValid = false;

    render(
      <JsonImportModal isOpen={true} onClose={vi.fn()} onImport={vi.fn()} />,
    );

    const textarea = screen.getByTestId("json-editor-input");
    fireEvent.change(textarea, {
      target: { value: '{"mcpServers":{"weather":{"command":"node"}}}' },
    });
    fireEvent.blur(textarea);
    const validateCallCountBeforeImport = (validateJsonConfig as Mock).mock
      .calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Import Servers" }));

    await waitFor(() => {
      expect(flushPendingValidationMock).toHaveBeenCalledTimes(1);
    });
    expect((validateJsonConfig as Mock).mock.calls.length).toBe(
      validateCallCountBeforeImport,
    );
    expect(parseJsonConfig).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Please fix JSON syntax errors before importing",
    );
  });

  it("revalidates config during import after flush succeeds", async () => {
    const onImport = vi.fn();
    (validateJsonConfig as Mock)
      .mockReturnValueOnce({ success: true })
      .mockReturnValue({
        success: false,
        error: "Missing mcpServers",
      });

    render(
      <JsonImportModal isOpen={true} onClose={vi.fn()} onImport={onImport} />,
    );

    const value = '{"mcpServers":{}}';
    const textarea = screen.getByTestId("json-editor-input");
    fireEvent.change(textarea, {
      target: { value },
    });
    fireEvent.blur(textarea);

    fireEvent.click(screen.getByRole("button", { name: "Import Servers" }));

    await waitFor(() => {
      expect(flushPendingValidationMock).toHaveBeenCalledTimes(1);
    });
    expect(validateJsonConfig).toHaveBeenNthCalledWith(2, value);
    expect(parseJsonConfig).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Please fix the JSON validation errors before importing",
    );
  });
});

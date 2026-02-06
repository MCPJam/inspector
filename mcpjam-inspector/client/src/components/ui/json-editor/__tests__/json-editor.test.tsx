import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JsonEditor } from "../json-editor";

describe("JsonEditor", () => {
  describe("autoFormatOnEdit", () => {
    it("formats valid raw content when entering edit mode", async () => {
      const onRawChange = vi.fn();

      const { rerender } = render(
        <JsonEditor
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="view"
          showToolbar={false}
        />,
      );

      expect(onRawChange).not.toHaveBeenCalled();

      rerender(
        <JsonEditor
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="edit"
          showToolbar={false}
        />,
      );

      await waitFor(() => {
        expect(onRawChange).toHaveBeenCalledWith('{\n  "a": 1\n}');
      });
    });

    it("does not format invalid raw content when entering edit mode", async () => {
      const onRawChange = vi.fn();

      const { rerender } = render(
        <JsonEditor
          rawContent="{invalid"
          onRawChange={onRawChange}
          mode="view"
          showToolbar={false}
        />,
      );

      rerender(
        <JsonEditor
          rawContent="{invalid"
          onRawChange={onRawChange}
          mode="edit"
          showToolbar={false}
        />,
      );

      await waitFor(() => {
        expect(onRawChange).not.toHaveBeenCalled();
      });
    });

    it("can disable auto formatting on edit", async () => {
      const onRawChange = vi.fn();

      const { rerender } = render(
        <JsonEditor
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="view"
          autoFormatOnEdit={false}
          showToolbar={false}
        />,
      );

      rerender(
        <JsonEditor
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="edit"
          autoFormatOnEdit={false}
          showToolbar={false}
        />,
      );

      await waitFor(() => {
        expect(onRawChange).not.toHaveBeenCalled();
      });
    });
  });

  describe("wrapLongLinesInEdit", () => {
    it("enables soft wrapping in edit mode when configured", () => {
      render(
        <JsonEditor
          rawContent='{"text":"long long long long long long"}'
          mode="edit"
          showToolbar={false}
          wrapLongLinesInEdit={true}
        />,
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea.getAttribute("wrap")).toBe("soft");
    });

    it("keeps wrapping disabled by default", () => {
      render(
        <JsonEditor
          rawContent='{"text":"long long long long long long"}'
          mode="edit"
          showToolbar={false}
        />,
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea.getAttribute("wrap")).toBe("off");
    });
  });

  describe("large edit mode", () => {
    const largeRawContent = `{"data":"${"x".repeat(8300)}"}`;
    const smallRawContent = `{"data":"${"x".repeat(2000)}"}`;

    it("uses minimal textarea rendering for payloads at or above threshold", () => {
      render(<JsonEditor rawContent={largeRawContent} mode="edit" />);

      expect(screen.getByTestId("json-editor-plain-textarea")).toBeInTheDocument();
      expect(
        screen.queryByTestId("json-editor-highlight-overlay"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("json-editor-line-numbers"),
      ).not.toBeInTheDocument();
    });

    it("keeps rich editor rendering below threshold", () => {
      render(<JsonEditor rawContent={smallRawContent} mode="edit" />);

      expect(
        screen.queryByTestId("json-editor-plain-textarea"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("json-editor-highlight-overlay"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("json-editor-line-numbers")).toBeInTheDocument();
    });

    it("hides undo/redo/format actions only in large mode", () => {
      const { rerender } = render(<JsonEditor rawContent={largeRawContent} mode="edit" />);

      expect(
        screen.queryByTestId("json-editor-undo-button"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("json-editor-redo-button"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("json-editor-format-button"),
      ).not.toBeInTheDocument();

      rerender(<JsonEditor rawContent={smallRawContent} mode="edit" />);

      expect(screen.getByTestId("json-editor-undo-button")).toBeInTheDocument();
      expect(screen.getByTestId("json-editor-redo-button")).toBeInTheDocument();
      expect(
        screen.getByTestId("json-editor-format-button"),
      ).toBeInTheDocument();
    });

    it("shows performance mode message only in large mode", () => {
      const { rerender } = render(<JsonEditor rawContent={largeRawContent} mode="edit" />);

      expect(
        screen.getByText("Performance mode active · validation runs on blur/save/run"),
      ).toBeInTheDocument();

      rerender(<JsonEditor rawContent={smallRawContent} mode="edit" />);

      expect(
        screen.queryByText(
          "Performance mode active · validation runs on blur/save/run",
        ),
      ).not.toBeInTheDocument();
    });

    it("emits dirty state changes immediately without waiting for parse", () => {
      const onDirtyChange = vi.fn();

      render(
        <JsonEditor
          rawContent={largeRawContent}
          mode="edit"
          onDirtyChange={onDirtyChange}
        />,
      );

      const textarea = screen.getByTestId("json-editor-plain-textarea");
      fireEvent.change(textarea, {
        target: { value: `${largeRawContent} ` },
      });

      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });

    it("flushes validation on blur in large mode", async () => {
      const onValidationError = vi.fn();
      const onChange = vi.fn();

      render(
        <JsonEditor
          rawContent={largeRawContent}
          onRawChange={vi.fn()}
          onChange={onChange}
          onValidationError={onValidationError}
          mode="edit"
        />,
      );

      const textarea = screen.getByTestId("json-editor-plain-textarea");
      fireEvent.change(textarea, {
        target: { value: `${largeRawContent.slice(0, -1)} ` },
      });

      expect(onChange).not.toHaveBeenCalled();

      fireEvent.blur(textarea);

      await waitFor(() => {
        const latest = onValidationError.mock.calls.at(-1)?.[0];
        expect(typeof latest).toBe("string");
      });
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
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
});

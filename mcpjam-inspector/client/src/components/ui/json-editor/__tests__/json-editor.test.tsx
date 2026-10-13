import { Profiler } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { JsonEditor } from "../json-editor";
import { buildLineLayouts } from "../json-editor-edit";

function getParseErrorMessage(source: string): string {
  try {
    JSON.parse(source);
    throw new Error("Expected invalid JSON for this test helper");
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid JSON";
  }
}

describe("JsonEditor", () => {
  describe("autoFormatOnEdit", () => {
    it("formats valid raw content when entering edit mode", async () => {
      const onRawChange = vi.fn();

      const { rerender } = render(
        <JsonEditor
          height="100%"
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="view"
          showToolbar={false}
        />,
      );

      expect(onRawChange).not.toHaveBeenCalled();

      rerender(
        <JsonEditor
          height="100%"
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
          height="100%"
          rawContent="{invalid"
          onRawChange={onRawChange}
          mode="view"
          showToolbar={false}
        />,
      );

      rerender(
        <JsonEditor
          height="100%"
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
          height="100%"
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="view"
          autoFormatOnEdit={false}
          showToolbar={false}
        />,
      );

      rerender(
        <JsonEditor
          height="100%"
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
          height="100%"
          rawContent='{"text":"long long long long long long"}'
          mode="edit"
          showToolbar={false}
          editSurface="legacy"
          wrapLongLinesInEdit={true}
        />,
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea.getAttribute("wrap")).toBe("soft");
    });

    it("keeps wrapping disabled by default", () => {
      render(
        <JsonEditor
          height="100%"
          rawContent='{"text":"long long long long long long"}'
          mode="edit"
          showToolbar={false}
          editSurface="legacy"
        />,
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea.getAttribute("wrap")).toBe("off");
    });

    it("uses the CodeMirror edit surface by default", () => {
      const { container } = render(
        <JsonEditor
          height="100%"
          rawContent='{"text":"long long long long long long"}'
          mode="edit"
          showToolbar={false}
          wrapLongLinesInEdit={true}
        />,
      );

      expect(container.querySelector(".cm-editor")).toBeTruthy();
      expect(container.querySelector(".cm-lineWrapping")).toBeTruthy();
      expect(container.querySelector("textarea")).toBeNull();
    });
  });

  describe("collapsible tree view sizing", () => {
    it("applies numeric height to the tree scroll container", () => {
      const { container } = render(
        <JsonEditor value={{ a: 1 }} viewOnly collapsible height={200} />,
      );

      const treeRoot = container.querySelector(".overflow-auto.pl-7");
      expect(treeRoot).toBeTruthy();
      expect((treeRoot as HTMLElement).style.height).toBe("200px");
    });

    it("defaults collapsible view height to 100% on the tree container", () => {
      const { container } = render(
        <JsonEditor value={{ a: 1 }} viewOnly collapsible />,
      );

      const treeRoot = container.querySelector(".overflow-auto.pl-7");
      expect(treeRoot).toBeTruthy();
      expect((treeRoot as HTMLElement).style.height).toBe("100%");
    });
  });

  describe("view-only value changes", () => {
    // A streaming trace hands the Raw view a new value on every token. The
    // view-only tree renders `value` itself, so each change should commit
    // once, with no follow-up state update from the edit buffer.
    it("commits once per new value and shows the latest one", () => {
      let commits = 0;
      const viewer = (tokens: number) => (
        <Profiler
          id="json-editor"
          onRender={() => {
            commits += 1;
          }}
        >
          <JsonEditor value={{ tokens }} viewOnly collapsible />
        </Profiler>
      );
      const { rerender } = render(viewer(0));

      const committedBeforeChanges = commits;
      for (let tokens = 1; tokens <= 20; tokens++) {
        rerender(viewer(tokens));
      }

      expect(commits - committedBeforeChanges).toBe(20);
      expect(screen.getByText("20")).toBeInTheDocument();
    });

    // The tool card flips a view-only editor into edit mode once its input
    // has finished streaming. The editor must start from the latest value.
    it("starts the editor from the latest value when viewOnly turns off", () => {
      const { rerender } = render(
        <JsonEditor value={{ tokens: 1 }} viewOnly collapsible />,
      );
      rerender(<JsonEditor value={{ tokens: 2 }} viewOnly collapsible />);

      rerender(
        <JsonEditor
          value={{ tokens: 2 }}
          height="100%"
          mode="edit"
          onModeChange={() => {}}
          showModeToggle={false}
          editSurface="legacy"
        />,
      );

      expect(screen.getByRole("textbox")).toHaveValue('{\n  "tokens": 2\n}');
    });
  });

  describe("error prop", () => {
    it("renders the error message inside the toolbar", () => {
      render(
        <JsonEditor
          height="100%"
          rawContent='{"a":1}'
          mode="edit"
          error="Unexpected token at line 3"
        />,
      );

      expect(screen.getByText("Unexpected token at line 3")).toBeInTheDocument();
    });

    it("renders the built-in validation error in the status bar by default", () => {
      const syntaxErrorMessage = getParseErrorMessage("{invalid");

      render(
        <JsonEditor
          height="100%"
          rawContent="{invalid"
          mode="edit"
        />,
      );

      expect(screen.getByText(syntaxErrorMessage)).toBeInTheDocument();
    });

    it("can suppress the bottom validation error when a parent renders one elsewhere", () => {
      const syntaxErrorMessage = getParseErrorMessage("{invalid");

      render(
        <JsonEditor
          height="100%"
          rawContent="{invalid"
          mode="edit"
          error="Top-level validation error"
          showValidationErrorInStatusBar={false}
        />,
      );

      expect(screen.getByText("Top-level validation error")).toBeInTheDocument();
      expect(screen.queryByText(syntaxErrorMessage)).not.toBeInTheDocument();
    });
  });

  describe("expandJsonStrings", () => {
    it("expands stringified JSON in viewOnly mode", () => {
      render(
        <JsonEditor
          value={{ toolInput: { elements: '[{"type":"ellipse","x":10}]' } }}
          viewOnly
          collapsible
          expandJsonStrings
        />,
      );

      expect(screen.getByText('"elements"')).toBeDefined();
      expect(screen.getByText('"type"')).toBeDefined();
      expect(screen.getByText("10")).toBeDefined();
    });
  });

  describe("readOnly line wrapping", () => {
    it("wraps long lines by default in view-only mode", () => {
      const { container } = render(
        <JsonEditor
          value={{ avatarUrl: `https://${"a".repeat(120)}` }}
          viewOnly
        />,
      );

      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("whitespace-pre-wrap");
      expect(pre?.className).toContain("break-words");
    });

    it("uses a shared read-only viewport for scrollbar and gesture scrolling", () => {
      const { container } = render(
        <JsonEditor
          value={{ avatarUrl: `https://${"a".repeat(120)}` }}
          viewOnly
        />,
      );

      const viewport = container.querySelector(
        ".overflow-auto.overscroll-none",
      );
      expect(viewport).toBeTruthy();
      expect(viewport?.className).toContain("items-start");
      expect(viewport?.className).toContain("z-10");

      const gutter = container.querySelector(
        ".self-stretch.flex-shrink-0.text-right.select-none",
      );
      expect(gutter?.className).toContain("self-stretch");
      expect(gutter?.className).toContain("sticky");
      expect(gutter?.className).toContain("bg-muted/50");
      expect(gutter?.className).toContain("border-r");

      const pre = container.querySelector("pre");
      expect(pre?.className).not.toContain("overflow-auto");
    });

    it("keeps horizontal overflow on the shared read-only viewport", () => {
      const { container } = render(
        <JsonEditor
          value={{ items: [{ id: 1 }] }}
          viewOnly
          height={200}
          wrapLongLinesInView={false}
        />,
      );

      const innerCol = container.querySelector("pre")?.parentElement;
      expect(innerCol).toBeTruthy();
      expect(innerCol?.className).toContain("overflow-visible");
      expect(innerCol?.className).toContain("w-max");
      expect(innerCol?.className).not.toContain("overflow-x-auto");
      expect(innerCol?.className).not.toContain("overflow-y-clip");

      expect(
        container.querySelector(".overflow-auto.overscroll-none"),
      ).toBeTruthy();
    });

    it("can disable wrapping in view-only mode", () => {
      const { container } = render(
        <JsonEditor
          value={{ avatarUrl: `https://${"a".repeat(120)}` }}
          viewOnly
          wrapLongLinesInView={false}
        />,
      );

      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("whitespace-pre");
      expect(pre?.className).not.toContain("whitespace-pre-wrap");
    });

    it("accounts for wrapped lines when calculating line number heights", () => {
      const layouts = buildLineLayouts(
        [
          "{",
          `  "avatarUrl": "${"a".repeat(120)}",`,
          '  "status": "Offline"',
          "}",
        ],
        true,
        40,
      );

      expect(layouts[1]?.height).toBeGreaterThan(20);
      expect(layouts[2]?.top).toBe(
        (layouts[0]?.height ?? 0) + (layouts[1]?.height ?? 0),
      );
    });
  });
});

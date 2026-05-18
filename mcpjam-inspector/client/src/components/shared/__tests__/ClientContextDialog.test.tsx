import type { ChangeEvent, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHostContextStore } from "@/stores/client-context-store";
import { ClientContextDialog } from "../ClientContextDialog";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span data-testid="icon-alert" />,
  RotateCcw: () => <span data-testid="icon-reset" />,
  Save: () => <span data-testid="icon-save" />,
}));

vi.mock("@mcpjam/design-system/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@mcpjam/design-system/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div>
      <button aria-label="Close" onClick={() => onOpenChange(false)}>
        Close
      </button>
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({
    rawContent,
    onRawChange,
  }: {
    rawContent: string;
    onRawChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Host context JSON"
      value={rawContent}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
        onRawChange(event.currentTarget.value)
      }
    />
  ),
}));

vi.mock("@/hooks/use-project-client-config-sync-pending", () => ({
  useProjectClientConfigSyncPending: () => false,
}));

describe("ClientContextDialog", () => {
  beforeEach(() => {
    useHostContextStore.getState().loadProjectHostContext({
      projectId: "project-1",
      defaultHostContext: { theme: "light" },
      savedHostContext: { theme: "light" },
    });
  });

  it("discards unsaved draft changes when closed without saving", () => {
    const onOpenChange = vi.fn();

    render(
      <ClientContextDialog
        activeProjectId="project-1"
        open
        onOpenChange={onOpenChange}
        onSaveHostContext={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Host context JSON"), {
      target: { value: '{ "theme": "dark" }' },
    });

    expect(useHostContextStore.getState().draftHostContext).toEqual({
      theme: "dark",
    });
    expect(useHostContextStore.getState().isDirty).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useHostContextStore.getState().draftHostContext).toEqual({
      theme: "light",
    });
    expect(useHostContextStore.getState().isDirty).toBe(false);
  });
});

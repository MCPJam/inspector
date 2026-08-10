/**
 * NameEnvironmentDialog — promotion of an ad-hoc row, in place.
 *
 * The load-bearing behaviours:
 *  - `expectedRevision` is captured when the dialog OPENS and survives the
 *    reactive prop updating underneath it — substituting the fresh revision at
 *    submit would defeat the double-promote handshake.
 *  - Backend rejections render VERBATIM: the three CONFLICT causes (already
 *    named / row changed / name taken) are distinct instructions, and the
 *    dialog stays open so the user can act on them.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const { promoteMock, toastMock } = vi.hoisted(() => ({
  promoteMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  usePromoteProjectEnvironment: () => promoteMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

import { NameEnvironmentDialog } from "../NameEnvironmentDialog";

const adhocEnvironment = {
  environmentId: "env-1",
  projectId: "p1",
  origin: "adhoc",
  hostId: "host-1",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
} as unknown as ProjectEnvironmentView;

const renderDialog = (props: {
  open?: boolean;
  environment?: ProjectEnvironmentView;
  onOpenChange?: (open: boolean) => void;
}) =>
  render(
    <NameEnvironmentDialog
      open={props.open ?? true}
      onOpenChange={props.onOpenChange ?? vi.fn()}
      projectId="p1"
      environment={props.environment ?? adhocEnvironment}
    />,
  );

const typeName = (value: string) =>
  fireEvent.change(screen.getByTestId("name-environment-name-input"), {
    target: { value },
  });

beforeEach(() => {
  vi.clearAllMocks();
  promoteMock.mockResolvedValue(adhocEnvironment);
});

describe("NameEnvironmentDialog", () => {
  it("submits the revision captured at open, blank description omitted", async () => {
    renderDialog({});

    typeName("  Checkout flow  ");
    fireEvent.click(screen.getByTestId("name-environment-submit"));

    await waitFor(() => expect(promoteMock).toHaveBeenCalledTimes(1));
    expect(promoteMock).toHaveBeenCalledWith({
      projectId: "p1",
      environmentId: "env-1",
      expectedRevision: 1,
      name: "Checkout flow",
    });
  });

  it("keeps the captured revision when the reactive row changes under an open dialog", async () => {
    const { rerender } = renderDialog({});

    // The row updates underneath (another member touched it) — the open
    // dialog must still send what it was editing against, so the backend's
    // CONFLICT fires instead of a silent clobber.
    rerender(
      <NameEnvironmentDialog
        open
        onOpenChange={vi.fn()}
        projectId="p1"
        environment={
          { ...(adhocEnvironment as object), revision: 7 } as never
        }
      />,
    );

    typeName("Checkout flow");
    fireEvent.click(screen.getByTestId("name-environment-submit"));

    await waitFor(() => expect(promoteMock).toHaveBeenCalledTimes(1));
    expect(promoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1 }),
    );
  });

  it("sends the description when one is provided", async () => {
    renderDialog({});

    typeName("Checkout flow");
    fireEvent.change(
      screen.getByTestId("name-environment-description-input"),
      { target: { value: "Staging servers for the checkout revamp" } },
    );
    fireEvent.click(screen.getByTestId("name-environment-submit"));

    await waitFor(() =>
      expect(promoteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Staging servers for the checkout revamp",
        }),
      ),
    );
  });

  it("renders the backend's rejection verbatim and stays open", async () => {
    promoteMock.mockRejectedValue({
      data: {
        code: "CONFLICT",
        message: 'An environment named "Checkout flow" already exists.',
      },
    });
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    typeName("Checkout flow");
    fireEvent.click(screen.getByTestId("name-environment-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("name-environment-error")).toHaveTextContent(
        'An environment named "Checkout flow" already exists.',
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("disables submit while the name is empty", () => {
    renderDialog({});

    expect(screen.getByTestId("name-environment-submit")).toBeDisabled();
    typeName("   ");
    expect(screen.getByTestId("name-environment-submit")).toBeDisabled();
  });

  it("closes and toasts on success", async () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    typeName("Checkout flow");
    fireEvent.click(screen.getByTestId("name-environment-submit"));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining('Saved as "Checkout flow"'),
    );
  });
});

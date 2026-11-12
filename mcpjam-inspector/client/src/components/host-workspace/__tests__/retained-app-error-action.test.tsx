import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetainedAppErrorAction } from "../RetainedAppErrorAction";
import type { AppRow } from "../ThreadAppPanel";

const server = { serverId: "srv", name: "Board server" };
const declaration = {
  toolName: "inline_note",
  title: "Inline note",
  kind: "global" as const,
};

function errorRow(patch: Pick<AppRow, "retryable" | "closing">): AppRow {
  return {
    key: "row",
    server,
    declaration,
    status: "error",
    error: "Tool approval was denied. Close this App to finish.",
    abort: new AbortController(),
    ...patch,
  };
}

function setup(row: AppRow, inline: boolean) {
  const close = vi.fn(async () => {});
  const retry = vi.fn(async () => {});
  render(
    <RetainedAppErrorAction
      row={row}
      inline={inline}
      close={close}
      retry={retry}
    />,
  );
  return { close, retry };
}

afterEach(cleanup);

describe("RetainedAppErrorAction", () => {
  it("lets an inline App that can't be retried be closed", () => {
    const row = errorRow({ retryable: false });
    const { close, retry } = setup(row, true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledWith(row);
    expect(retry).not.toHaveBeenCalled();
  });

  it("offers nothing for a rail or takeover App that can't be retried, whose header closes it", () => {
    setup(errorRow({ retryable: false }), false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([true, false])("retries a retryable App (inline: %s)", (inline) => {
    const { close, retry } = setup(errorRow({}), inline);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith(server, declaration);
    expect(close).not.toHaveBeenCalled();
  });

  it.each([true, false])("retries a failed close (inline: %s)", (inline) => {
    const row = errorRow({ closing: true, retryable: false });
    const { close } = setup(row, inline);
    fireEvent.click(screen.getByRole("button", { name: "Retry close" }));
    expect(close).toHaveBeenCalledWith(row);
  });
});

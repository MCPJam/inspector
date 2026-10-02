import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDeleteRunLaunch } from "../delete-run-launch";

function Harness({
  deleteRun,
}: {
  deleteRun: (runId: string) => Promise<void>;
}) {
  const { request, dialog } = useDeleteRunLaunch(deleteRun);
  useEffect(() => {
    request({ runIds: ["run-a", "run-b", "run-c"], runNumber: 4 });
  }, [request]);
  return dialog;
}

describe("useDeleteRunLaunch", () => {
  it("retries only the runs a failed launch delete left behind", async () => {
    const user = userEvent.setup();
    let failOnce = true;
    const deleteRun = vi.fn(async (runId: string) => {
      if (runId === "run-b" && failOnce) {
        failOnce = false;
        throw new Error("boom");
      }
    });
    render(<Harness deleteRun={deleteRun} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteRun.mock.calls.map(([id]) => id)).toEqual(["run-a", "run-b"]);
    // The failure keeps the dialog open for a retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    // run-a is already gone, so the retry does not ask for it again.
    expect(deleteRun.mock.calls.map(([id]) => id)).toEqual([
      "run-a",
      "run-b",
      "run-b",
      "run-c",
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

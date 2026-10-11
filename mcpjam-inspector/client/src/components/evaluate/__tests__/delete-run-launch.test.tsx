import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { useDeleteRunLaunch } from "../delete-run-launch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function Harness({
  deleteRun,
}: {
  deleteRun: (runId: string) => Promise<unknown>;
}) {
  const { request, dialog } = useDeleteRunLaunch(deleteRun);
  useEffect(() => {
    request({ runIds: ["run-a", "run-b", "run-c"], runNumber: 4 });
  }, [request]);
  return dialog;
}

describe("useDeleteRunLaunch", () => {
  it("retains the remaining runs after acceptance without submitting a conflicting request", async () => {
    const receipt = { accepted: true, deleted: false, requestId: "receipt-a" };
    const deleteRun = vi.fn().mockResolvedValue(receipt);
    const user = userEvent.setup();
    render(<Harness deleteRun={deleteRun} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteRun.mock.calls).toEqual([["run-a"]]);
    expect(toast.success).toHaveBeenLastCalledWith(
      "Deletion started for 1 run. 2 run(s) not submitted. Retry after deletion finishes.",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("2 selected runs");
    expect(screen.getByRole("dialog")).toHaveTextContent("Any remaining runs stay selected while deletion is in progress.");
    deleteRun.mockRejectedValueOnce(new Error("DELETION_IN_PROGRESS"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteRun.mock.calls).toEqual([["run-a"], ["run-b"]]);
    expect(toast.error).toHaveBeenLastCalledWith(
      "2 run(s) not confirmed. Retry explicitly.",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("2 selected runs");
    expect(screen.getByRole("dialog")).toHaveTextContent("Any remaining runs stay selected while deletion is in progress.");
  });
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

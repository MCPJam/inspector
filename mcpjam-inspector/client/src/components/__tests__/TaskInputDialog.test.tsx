import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskInputDialog } from "../tasks/TaskInputDialog";

describe("Task URL consent", () => {
  afterEach(() => vi.restoreAllMocks());
  it("opens the requested URL only after consent and returns the bare action", async () => {
    const replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      opener: window,
      location: { replace },
    } as unknown as Window);
    const respond = vi.fn().mockResolvedValue(true);
    render(
      <TaskInputDialog
        prompt={{
          key: "consent",
          mode: "url",
          message: "Connect the Task account",
          url: "https://example.test/connect?state=opaque",
        }}
        serverId="server"
        timestamp="2026-10-30T00:00:00Z"
        onResponse={respond}
        loading={false}
      />,
    );
    expect(replace).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /open in new tab/i }),
    );
    expect(replace).toHaveBeenCalledWith(
      "https://example.test/connect?state=opaque",
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith("accept", undefined);
  });
  it("ignores dismissal while acceptance is pending and permits retry after failure", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
      location: { replace: vi.fn() },
    } as unknown as Window);
    let settle!: (accepted: boolean) => void;
    const respond = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValue(true);
    render(
      <TaskInputDialog
        prompt={{
          key: "consent",
          mode: "url",
          message: "Connect",
          url: "https://example.test/connect",
        }}
        serverId="server"
        timestamp="2026-10-30T00:00:00Z"
        onResponse={respond}
        loading={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /open in new tab/i }));
    await user.keyboard("{Escape}");
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => settle(false));
    await user.click(screen.getByRole("button", { name: /decline/i }));
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1][0]).toBe("decline");
    await user.keyboard("{Escape}");
    expect(respond).toHaveBeenCalledTimes(2);
  });
});

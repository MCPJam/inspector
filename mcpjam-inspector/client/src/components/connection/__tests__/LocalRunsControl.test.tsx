import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { LocalRunsControl } from "../LocalRunsControl";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function mount(
  allowed: boolean,
  onChange = vi.fn().mockResolvedValue(undefined),
) {
  render(<LocalRunsControl allowed={allowed} onChange={onChange} />);
  return onChange;
}

async function flip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("switch", { name: "Allow local runs" }));
  return await screen.findByRole("alertdialog");
}

describe("LocalRunsControl", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("allows local runs only once the admin confirms the tokens leave MCPJam", async () => {
    const user = userEvent.setup();
    const onChange = mount(false);
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(
      screen.getByText(/Turn this on so their local apps can too/),
    ).toBeTruthy();

    const dialog = await flip(user);
    expect(dialog).toHaveTextContent(
      "Members' local apps will receive the project accounts' access tokens",
    );
    expect(dialog).toHaveTextContent(
      "A token already sent keeps working until it expires, even after you stop local runs.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();

    await flip(user);
    await user.click(screen.getByRole("button", { name: "Allow local runs" }));
    expect(onChange).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Local runs allowed."),
    );
  });

  it("stops local runs and says delivered tokens keep working until they expire", async () => {
    const user = userEvent.setup();
    const onChange = mount(true);
    expect(screen.getByRole("switch")).toBeChecked();

    const dialog = await flip(user);
    expect(dialog).toHaveTextContent(
      "A token already sent keeps working until it expires.",
    );
    await user.click(screen.getByRole("button", { name: "Stop local runs" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("stays disabled until the saved value comes back", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <LocalRunsControl allowed={false} onChange={onChange} />,
    );
    await flip(user);
    await user.click(screen.getByRole("button", { name: "Allow local runs" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // The refetch hasn't landed: a second click must not offer Allow again.
    expect(screen.getByRole("switch")).toBeDisabled();
    rerender(<LocalRunsControl allowed onChange={onChange} />);
    expect(screen.getByRole("switch")).toBeEnabled();
  });

  it("re-enables when the reload shows another admin's value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <LocalRunsControl allowed={false} listVersion={1} onChange={onChange} />,
    );
    await flip(user);
    await user.click(screen.getByRole("button", { name: "Allow local runs" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.getByRole("switch")).toBeDisabled();
    // Another admin turned it off again: the list reloads, still not allowed.
    rerender(
      <LocalRunsControl allowed={false} listVersion={2} onChange={onChange} />,
    );
    expect(screen.getByRole("switch")).toBeEnabled();
    expect(screen.getByRole("switch")).not.toBeChecked();
  });

  it("waits for the save's own reload when another reload lands mid-save", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onChange = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { rerender } = render(
      <LocalRunsControl allowed={false} listVersion={1} onChange={onChange} />,
    );
    await flip(user);
    await user.click(screen.getByRole("button", { name: "Allow local runs" }));
    // An unrelated reload lands while the write is still pending.
    rerender(
      <LocalRunsControl allowed={false} listVersion={2} onChange={onChange} />,
    );
    finish();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.getByRole("switch")).toBeDisabled();
    // The reload the save triggered lands.
    rerender(<LocalRunsControl allowed listVersion={3} onChange={onChange} />);
    expect(screen.getByRole("switch")).toBeEnabled();
  });

  it("says the write failed when it fails for another reason", async () => {
    const user = userEvent.setup();
    mount(false, vi.fn().mockRejectedValue(new Error("network down")));
    await flip(user);
    await user.click(screen.getByRole("button", { name: "Allow local runs" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not allow local runs. Try again.",
      ),
    );
    expect(screen.getByRole("switch")).toBeEnabled();
  });

  it("shows the backend's refusal when the write is refused", async () => {
    const user = userEvent.setup();
    mount(
      false,
      vi.fn().mockRejectedValue(
        new ConvexError({
          code: "FORBIDDEN",
          message:
            "Only a project admin can change whether local runs may use this server's shared sign-in. Ask a project admin.",
        }),
      ),
    );
    await flip(user);
    await user.click(screen.getByRole("button", { name: "Allow local runs" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Only a project admin can change whether local runs may use this server's shared sign-in. Ask a project admin.",
      ),
    );
  });

  it("speaks of a web client's saved sign-ins, not a server's tokens", async () => {
    const user = userEvent.setup();
    render(
      <LocalRunsControl
        allowed
        noun="client"
        onChange={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(
      screen.getByText("Members' local apps can use these accounts' saved sign-ins."),
    ).toBeTruthy();
    const dialog = await flip(user);
    expect(dialog).toHaveTextContent("Stop local runs for this client?");
    expect(dialog.textContent).not.toMatch(/token|server/i);
  });
});

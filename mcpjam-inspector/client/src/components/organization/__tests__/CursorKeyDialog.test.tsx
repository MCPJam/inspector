import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { CursorKeyDialog } from "../CursorKeyDialog";
import type { CheckedCursorKey } from "@/hooks/useCursorProvider";

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const checked: CheckedCursorKey = { identity: { kind: "user", label: "runner@example.com" }, modelCount: 47 };
function mount(overrides: Partial<Parameters<typeof CursorKeyDialog>[0]> = {}) {
  const props = { view: { configured: false }, checkKey: vi.fn(async () => checked), saveKey: vi.fn(async () => checked), onClose: vi.fn(), ...overrides };
  render(<CursorKeyDialog {...props} />);
  return props;
}
function enter(value: string) { fireEvent.change(screen.getByLabelText("API Key"), { target: { value } }); }

describe("Cursor key setup", () => {
  it("shows the checked identity before Save and sends that identity on Save", async () => {
    const props = mount();
    enter("fixture-key");
    expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check key" }));
    expect(await screen.findByText("runner@example.com")).toBeInTheDocument();
    expect(screen.getByText("47 models")).toBeInTheDocument();
    expect(props.saveKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(props.saveKey).toHaveBeenCalledWith("fixture-key", checked.identity));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("keeps a refused key in the field and displays the server's message inline", async () => {
    const message = "Cursor rejected this key. Copy the complete key and try again.";
    const props = mount({ checkKey: vi.fn(async () => { throw new ConvexError({ message }); }) });
    enter("bad-fixture-key");
    fireEvent.click(screen.getByRole("button", { name: "Check key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("API Key")).toHaveValue("bad-fixture-key");
    expect(props.saveKey).not.toHaveBeenCalled();
  });
  it("does not authorize Save with a response for a key that has changed", async () => {
    let resolve!: (value: CheckedCursorKey) => void;
    mount({ checkKey: vi.fn(() => new Promise((done) => { resolve = done; })) });
    enter("first-key");
    fireEvent.click(screen.getByRole("button", { name: "Check key" }));
    enter("second-key");
    await act(async () => resolve(checked));
    expect(screen.queryByText("runner@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
  });
  it("keeps the current account until a replacement has been checked and saved", async () => {
    const props = mount({ view: { configured: true, identity: { kind: "service_account", label: "current-runner" } } });
    expect(screen.getByText("Current account: current-runner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    fireEvent.change(screen.getByLabelText("New API key"), { target: { value: "replacement-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.saveKey).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

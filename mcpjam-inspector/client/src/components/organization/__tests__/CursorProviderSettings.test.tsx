import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CursorProviderSettings } from "../CursorProviderSettings";
const mocks = vi.hoisted(() => ({ enabled: true, view: { configured: true, identity: { kind: "user", label: "private-owner@example.com" }, modelCount: 47 }, refresh: vi.fn(), remove: vi.fn(), error: vi.fn() }));
vi.mock("@/hooks/useCursorHostEnabled", () => ({ useCursorHostEnabled: () => mocks.enabled }));
vi.mock("@/hooks/useCursorProvider", () => ({ useCursorProvider: () => ({ view: mocks.view, refreshModels: mocks.refresh, removeKey: mocks.remove, checkKey: vi.fn(), saveKey: vi.fn() }) }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: mocks.error } }));
beforeEach(() => { mocks.enabled = true; mocks.refresh.mockReset(); mocks.remove.mockReset(); mocks.error.mockReset(); });
describe("Cursor organization provider", () => {
  it("is absent when the internal flag is off", () => {
    mocks.enabled = false;
    render(<CursorProviderSettings organizationId="org" isAdmin showUnconfigured />);
    expect(screen.queryByText("Cursor")).not.toBeInTheDocument();
  });
  it("only exposes configured status to members", () => {
    render(<CursorProviderSettings organizationId="org" isAdmin={false} showUnconfigured />);
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.queryByText(/private-owner/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("retains the catalog status when refresh fails", async () => {
    mocks.refresh.mockResolvedValue({ applied: false });
    render(<CursorProviderSettings organizationId="org" isAdmin showUnconfigured />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Cursor models" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("previous list")));
    expect(screen.getByText(/47 models/)).toBeInTheDocument();
  });
  it("keeps the removal confirmation open if removal fails", async () => {
    mocks.remove.mockRejectedValue(new Error("failed"));
    render(<CursorProviderSettings organizationId="org" isAdmin showUnconfigured />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Cursor" }));
    expect(screen.getByText(/runs in this organization stop/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove key", exact: true }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

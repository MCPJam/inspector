import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionRefreshBanner } from "../session-refresh-banner";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  signIn: vi.fn(),
}));
const rememberReturn = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-inspector-auth", () => ({ useInspectorAuth: () => auth }));
vi.mock("@/lib/app-signin-return-path", () => ({ captureAppSignInReturnPath: rememberReturn }));
vi.mock("@/lib/permalink-signin-return", () => ({ permalinkSignInOptions: () => ({ state: "return-to-app" }) }));

describe("session refresh sign-in recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    useSessionRefreshStore.setState({ status: "failed", kind: "transient" });
  });

  it("lets a visitor sign in when guest bootstrap cannot recover", () => {
    render(<SessionRefreshBanner />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(rememberReturn).toHaveBeenCalledOnce();
    expect(auth.signIn).toHaveBeenCalledWith({ state: "return-to-app" });
  });

  it("also offers sign-in after a manual guest rejection", () => {
    useSessionRefreshStore.setState({ kind: "manual" });
    render(<SessionRefreshBanner />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("keeps a signed-in transient failure on the existing retry path", () => {
    auth.user = { id: "member" };
    render(<SessionRefreshBanner />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("shows one sign-in action after the session expires", () => {
    useSessionRefreshStore.setState({ kind: "signed_out" });
    render(<SessionRefreshBanner />);
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("does not show recovery controls for a healthy session", () => {
    useSessionRefreshStore.setState({ status: "idle", kind: null });
    render(<SessionRefreshBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddServerModal } from "../AddServerModal";

// AddServerModal reaches for auth, app-readiness and analytics at render time;
// stub them so the modal mounts standalone.
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock("@/hooks/use-app-ready", () => ({
  useAppReady: () => ({ status: "ready" }),
  useAppReadyMessage: () => null,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

describe("AddServerModal — browser translation", () => {
  // Regression: on a Chrome-translated page, cancelling this modal threw
  // NotFoundError from `removeChild` once the close animation unmounted the
  // portal. The translator had swapped the dialog's text nodes for `<font>`
  // wrappers, so the nodes React held references to were no longer children
  // of their parents.
  it("prevents browser translation from rewriting the portaled dialog", () => {
    render(
      <AddServerModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} />,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("translate", "no");
    expect(screen.getByRole("dialog")).toHaveClass("notranslate");
  });
});

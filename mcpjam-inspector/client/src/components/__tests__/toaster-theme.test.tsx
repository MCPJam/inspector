import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Toaster } from "@mcpjam/design-system/sonner";

// Sonner styles the toast description from its own resolved theme, not from the
// CSS vars we hand it. So the theme it resolves has to match the one the app is
// actually painting, or a light-mode toast gets a near-white description on the
// white background our vars supplied.
function toasterTheme(): string | null {
  return (
    document
      .querySelector("[data-sonner-toaster]")
      ?.getAttribute("data-sonner-theme") ?? null
  );
}

function showToast() {
  toast("Client update available", { description: "Has a newer config." });
}

// The toaster element only exists once there is something to show.
async function renderWithToast(ui = <Toaster />) {
  const view = render(ui);
  showToast();
  await waitFor(() => expect(toasterTheme()).not.toBeNull());
  return view;
}

afterEach(() => {
  toast.dismiss();
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

describe("Toaster theme", () => {
  it("resolves light when the document is not in dark mode", async () => {
    await renderWithToast();

    expect(toasterTheme()).toBe("light");
  });

  it("resolves dark from the `.dark` class the tokens are scoped under", async () => {
    document.documentElement.classList.add("dark");

    await renderWithToast();

    expect(toasterTheme()).toBe("dark");
  });

  // The class is toggled at runtime by the theme switcher, long after mount.
  it("follows the class when it changes after mount", async () => {
    await renderWithToast();
    expect(toasterTheme()).toBe("light");

    document.documentElement.classList.add("dark");

    await waitFor(() => expect(toasterTheme()).toBe("dark"));
  });

  // Switching back has to work too: tracking only one direction would leave a
  // toast dark on the light theme, which is the same class of bug in reverse.
  it("follows the class back when dark is removed after mount", async () => {
    document.documentElement.classList.add("dark");
    await renderWithToast();
    expect(toasterTheme()).toBe("dark");

    document.documentElement.classList.remove("dark");

    await waitFor(() => expect(toasterTheme()).toBe("light"));
  });

  // The props spread sits after our `theme`, so a caller can still opt out of
  // the document entirely. Asserted because that ordering is easy to undo.
  it.each([
    ["dark over a light document", "dark" as const, false],
    ["light over a dark document", "light" as const, true],
  ])("lets an explicit theme prop win: %s", async (_label, theme, documentDark) => {
    if (documentDark) document.documentElement.classList.add("dark");

    await renderWithToast(<Toaster theme={theme} />);

    expect(toasterTheme()).toBe(theme);
  });

  // Defensive branch: every environment with `document` also has
  // MutationObserver, so this is about degrading gracefully rather than a path
  // real browsers take. The theme is still right at mount; it just stops
  // tracking. Restored before `waitFor`, which uses MutationObserver itself.
  it("keeps the mount-time theme when MutationObserver is unavailable", async () => {
    document.documentElement.classList.add("dark");
    const RealMutationObserver = globalThis.MutationObserver;
    vi.stubGlobal("MutationObserver", undefined);

    let view;
    try {
      view = render(<Toaster />);
      showToast();
    } finally {
      vi.stubGlobal("MutationObserver", RealMutationObserver);
    }

    await waitFor(() => expect(toasterTheme()).toBe("dark"));

    document.documentElement.classList.remove("dark");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toasterTheme()).toBe("dark");
    expect(view).toBeDefined();
  });
});

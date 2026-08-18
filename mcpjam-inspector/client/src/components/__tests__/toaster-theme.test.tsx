import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

// The toaster element only exists once there is something to show.
async function renderWithToast() {
  const view = render(<Toaster />);
  toast("Client update available", { description: "Has a newer config." });
  await waitFor(() => expect(toasterTheme()).not.toBeNull());
  return view;
}

afterEach(() => {
  toast.dismiss();
  document.documentElement.classList.remove("dark");
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
});

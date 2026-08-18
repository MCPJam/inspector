import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { toast } from "sonner";
import { Toaster } from "@mcpjam/design-system/sonner";

// Read off disk rather than imported: vitest runs with its default `css: false`,
// which stubs CSS imports (including `?raw`) to an empty string. A rule copied
// into this file would only ever test the copy.
function designSystemStyleDir(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = resolve(dir, "design-system/src");
    if (existsSync(resolve(candidate, "index.css"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`design-system/src not found upward from ${process.cwd()}`);
}

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

  // Sonner ships its own `[data-description] { color: #3f3f3f }` and injects it
  // at runtime, so ours reaches the element only by outranking that one. This
  // pins which declaration wins. It cannot pin the painted colour: jsdom does
  // not resolve `var()` (a literal colour resolves; `var(--foreground)` comes
  // back verbatim), so the resolved value is measured in a browser instead —
  // rgb(232, 232, 232) before this fix, `--foreground` after.
  it("lets our description colour outrank sonner's own", async () => {
    const styleDir = designSystemStyleDir();
    const style = document.createElement("style");
    style.textContent = [
      readFileSync(resolve(styleDir, "tokens.css"), "utf8"),
      // jsdom does not follow @import, and tokens.css is already inlined above.
      readFileSync(resolve(styleDir, "index.css"), "utf8").replace(
        /@import[^;]+;/g,
        ""
      ),
    ].join("\n");
    document.head.appendChild(style);

    try {
      await renderWithToast();

      const description = document.querySelector("[data-description]");
      expect(description).not.toBeNull();
      expect(getComputedStyle(description!).color).toBe("var(--foreground)");
    } finally {
      style.remove();
    }
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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `inModal` inside a Dialog, guarded by a grep.
 *
 * The picker portals its popover by default. A modal Dialog's overlay then
 * swallows every click on it, so the picker opens and cannot be used — and
 * nothing throws. Surfaces that mock the picker in their own tests cannot see
 * this at all, which is how two call sites carried the bug for as long as they
 * did. A missing prop is invisible to type checking and to every DOM test that
 * does not click through the real popover; only reading the source catches it.
 *
 * SCOPE, because a ratchet that overstates itself is worse than none: this
 * only sees files that render `<DialogContent` THEMSELVES. A picker whose
 * overlay comes from a wrapper in another file passes unexamined. Closing that
 * needs the render tree, not a grep. What is caught is the shape that actually
 * regressed — a picker and its dialog written in one file.
 */
const CLIENT_SRC = join(__dirname, "..", "..", "..");

/**
 * Each `<ServerPicker …/>` element in a file, as raw source. The name is
 * matched to a boundary so `<ServerPickerPanel` — a different component, with
 * no such prop — is not dragged in.
 */
export function serverPickerElements(source: string): string[] {
  const opening = /<ServerPicker(?=[\s/>])/g;
  const elements: string[] = [];
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    const close = source.indexOf("/>", match.index);
    if (close === -1) break;
    elements.push(source.slice(match.index, close + 2));
  }
  return elements;
}

/**
 * Whether an element turns portalling OFF. `inModal` alone or `inModal={true}`
 * count; `inModal={false}` is the same as absent, and a variable is not
 * something a grep can resolve, so it does not count either.
 */
export function disablesPortal(element: string): boolean {
  return /\binModal(?:\s*=\s*\{\s*true\s*\})?[\s/>]/.test(element);
}

function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") collectTsx(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("ServerPicker inside a modal Dialog", () => {
  it("always receives inModal", () => {
    const offenders: string[] = [];

    for (const file of collectTsx(CLIENT_SRC)) {
      if (file.includes("__tests__")) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("<ServerPicker")) continue;
      if (!source.includes("<DialogContent")) continue;

      for (const element of serverPickerElements(source)) {
        if (!disablesPortal(element)) offenders.push(relative(CLIENT_SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("what the grep above actually matches", () => {
  it("does not mistake ServerPickerPanel for the picker", () => {
    // `server-picker.tsx` renders the panel. It escapes the scan today only
    // because it has no `<DialogContent`; a file with both would be failed
    // for a prop the panel does not take.
    const source = `<ServerPickerPanel tab={tab} onTabChange={setTab} />`;
    expect(serverPickerElements(source)).toEqual([]);
  });

  it("finds the picker whether the prop list wraps or not", () => {
    const source = `
      <ServerPicker projectId={id} inModal />
      <ServerPicker
        projectId={id}
      />
    `;
    expect(serverPickerElements(source)).toHaveLength(2);
  });

  it("counts the shorthand and the explicit true", () => {
    expect(disablesPortal(`<ServerPicker inModal />`)).toBe(true);
    expect(disablesPortal(`<ServerPicker inModal={true} />`)).toBe(true);
    expect(disablesPortal(`<ServerPicker inModal\n  disabled />`)).toBe(true);
  });

  it("refuses a value that leaves the popover portaled", () => {
    // The hole worth naming: an element carrying the word `inModal` still
    // fails inside a modal when the value is false.
    expect(disablesPortal(`<ServerPicker inModal={false} />`)).toBe(false);
  });

  it("refuses a value it cannot read", () => {
    // A variable may be false at runtime. The grep cannot tell, so it does
    // not get to claim the call site is safe.
    expect(disablesPortal(`<ServerPicker inModal={inModal} />`)).toBe(false);
  });

  it("is not fooled by a similarly named prop", () => {
    expect(disablesPortal(`<ServerPicker notInModalAtAll />`)).toBe(false);
  });
});

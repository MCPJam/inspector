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
 */
const CLIENT_SRC = join(__dirname, "..", "..", "..");

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

/** Each `<ServerPicker … />` element in a file, as raw source. */
function serverPickerElements(source: string): string[] {
  const elements: string[] = [];
  let from = 0;
  for (;;) {
    const open = source.indexOf("<ServerPicker", from);
    if (open === -1) return elements;
    const close = source.indexOf("/>", open);
    if (close === -1) return elements;
    elements.push(source.slice(open, close + 2));
    from = close + 2;
  }
}

describe("ServerPicker inside a modal Dialog", () => {
  it("always receives inModal", () => {
    const offenders: string[] = [];

    for (const file of collectTsx(CLIENT_SRC)) {
      if (file.includes("__tests__")) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("<ServerPicker")) continue;
      // The overlay only exists where this component renders it.
      if (!source.includes("<DialogContent")) continue;

      for (const element of serverPickerElements(source)) {
        if (!element.includes("inModal")) {
          offenders.push(relative(CLIENT_SRC, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

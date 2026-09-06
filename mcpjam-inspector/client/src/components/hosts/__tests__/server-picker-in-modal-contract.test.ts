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
    const end = endOfOpeningTag(source, match.index);
    // Unclosed: skip this one and keep looking, rather than abandoning the
    // rest of the file and every `<ServerPicker` left in it.
    if (end === -1) continue;
    elements.push(source.slice(match.index, end));
  }
  return elements;
}

/**
 * Index just past the `>` that ends this element's OPENING tag, or -1.
 *
 * Brace depth and quoted values are tracked, because `indexOf("/>")` closed
 * the element at the FIRST self-closing tag anywhere after it. A prop holding
 * its own JSX — `renderItem={(s) => <Row />} inModal` — truncated the element
 * before `inModal` and failed a call site that was correct. It also never
 * matched the children form `<ServerPicker ...>...</ServerPicker>`, which has
 * no `/>` at all, so both forms read the same way now.
 */
function endOfOpeningTag(source: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    // A template literal is a quoted region too, and its `${…}` holds braces
    // that are not this element's. Without it, `title={`{`}` desynced the
    // depth and the element was truncated or skipped — either a correct call
    // site failing CI, or a missing `inModal` going unseen.
    if (c === "`") {
      i += 1;
      let expr = 0;
      while (i < source.length) {
        const t = source[i];
        if (t === "\\") {
          i += 2;
          continue;
        }
        if (expr === 0 && t === "`") break;
        if (t === "$" && source[i + 1] === "{") {
          expr += 1;
          i += 2;
          continue;
        }
        if (expr > 0 && t === "}") expr -= 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && c === ">") return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Whether an element turns portalling OFF. `inModal` alone and `inModal={true}`
 * count, and so does `inModal={inModal}` — a wrapper forwarding its own prop
 * has handed the decision to its caller, which is the shape the environment
 * composer uses and the only reason most pickers are reachable at all.
 * `inModal={false}` is the same as absent, and any OTHER expression is
 * something a grep cannot resolve, so it does not get to vouch for the site.
 */
export function disablesPortal(element: string): boolean {
  // Preceded by WHITESPACE, not just a word boundary: a JSX attribute always
  // is, while `\b` also matched the tail of `data-inModal`, which is a
  // different prop entirely and leaves the popover portaled.
  return /\sinModal(?:\s*=\s*\{\s*(?:true|inModal)\s*\})?[\s/>]/.test(
    element,
  );
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

describe("reading a <ServerPicker> element out of source", () => {
  it("does not end the element at a self-closing tag inside a prop", () => {
    // `indexOf("/>")` stopped at `<Row />` and never saw `inModal`, so a call
    // site that was correct failed the contract.
    const src = "<ServerPicker renderItem={(s) => <Row />} inModal />";
    const [element] = serverPickerElements(src);
    expect(element).toContain("inModal");
    expect(disablesPortal(element)).toBe(true);
  });

  it("reads the children form, which has no /> at all", () => {
    const src = "<ServerPicker inModal>\n  <Child />\n</ServerPicker>";
    const [element] = serverPickerElements(src);
    expect(element).toBeDefined();
    expect(disablesPortal(element)).toBe(true);
  });

  it("is not desynced by braces inside a quoted prop value", () => {
    // A string was already handled; a TEMPLATE was not, and its `${…}` braces
    // were counted as the element's own.
    for (const prop of ['title={"{"}', "title={`{`}", "title={`${'}'}`}"]) {
      const src = `<ServerPicker ${prop} inModal />`;
      const [element] = serverPickerElements(src);
      expect(element, prop).toContain("inModal");
      expect(disablesPortal(element), prop).toBe(true);
    }
  });

  it("yields nothing for an element that never closes", () => {
    // The `-1` path. It cannot be paired with a later, well-formed picker in
    // one fixture: with no `>` after the broken one, the scan for it runs to
    // the end of the file and swallows whatever follows. So this pins the
    // skip, and `continue` rather than `break` is what stops one unreadable
    // element from ending the search for the whole file.
    expect(serverPickerElements("<ServerPicker unclosed")).toEqual([]);
  });

  it("still refuses a picker that never turns portalling off", () => {
    const [element] = serverPickerElements('<ServerPicker projectId="p" />');
    expect(disablesPortal(element)).toBe(false);
  });
});

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
    // Anything but the forward: a differently named variable, or an
    // expression, may be false at runtime and the grep cannot tell.
    expect(disablesPortal(`<ServerPicker inModal={isNested} />`)).toBe(false);
    expect(disablesPortal(`<ServerPicker inModal={a && b} />`)).toBe(false);
  });

  it("counts a wrapper forwarding its own inModal", () => {
    // `environment-composer.tsx` passes `inModal={inModal}`. Refusing that
    // left every picker reached through the composer — most of them —
    // unvouched for by a ratchet whose whole job is to vouch.
    expect(disablesPortal(`<ServerPicker inModal={inModal} />`)).toBe(true);
  });

  it("is not fooled by a prop whose name merely ends in it", () => {
    // Lower case, so the `\b` anchor is what has to reject it. The previous
    // fixture used `notInModalAtAll`, whose capital I made the regex miss it
    // for a reason the test was not written to check.
    expect(disablesPortal(`<ServerPicker xinModal />`)).toBe(false);
    expect(disablesPortal(`<ServerPicker data-notinModal />`)).toBe(false);
    // A hyphen IS a word boundary, so `\b` alone let this through and the
    // ratchet vouched for a picker holding no such prop.
    expect(disablesPortal(`<ServerPicker data-inModal />`)).toBe(false);
    expect(disablesPortal(`<ServerPicker aria-inModal="x" />`)).toBe(false);
  });
});

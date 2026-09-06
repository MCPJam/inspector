import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `inModal` inside a Dialog, guarded by the compiler.
 *
 * The picker portals its popover by default. A modal Dialog's overlay then
 * swallows every click on it, so the picker opens and cannot be used — and
 * nothing throws. Surfaces that mock the picker in their own tests cannot see
 * this at all, which is how two call sites carried the bug for as long as they
 * did. A missing prop is invisible to type checking and to every DOM test that
 * does not click through the real popover; only reading the source catches it.
 *
 * Read through `typescript`, which the package already depends on, rather than
 * by matching text. The hand-written version counted braces and quotes to find
 * where an element ended, and got it wrong three times: a prop holding its own
 * JSX closed the element early, the children form was never matched at all,
 * and a template literal in a prop desynced the depth. None of that is a
 * question worth answering twice — the parser answers it.
 *
 * SCOPE, because a ratchet that overstates itself is worse than none: this
 * only sees files that render `<DialogContent` THEMSELVES. A picker whose
 * overlay comes from a wrapper in another file passes unexamined. Closing that
 * needs the render tree, not the syntax tree.
 */
const CLIENT_SRC = join(__dirname, "..", "..", "..");

/**
 * Whether this element hands portalling off.
 *
 * Bare `inModal`, `={true}`, and the forward `={inModal}` all count — the
 * environment composer passes its own prop through, and refusing that left
 * most pickers in the app unvouched for. Anything else is an expression whose
 * runtime value the source does not settle, so it does not get to vouch.
 */
function portalOff(element: ts.JsxOpeningLikeElement): boolean {
  const attr = element.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === "inModal",
  ) as ts.JsxAttribute | undefined;
  if (!attr) return false;
  if (!attr.initializer) return true;
  return /^\{\s*(?:true|inModal)\s*\}$/.test(attr.initializer.getText());
}

/** Every `<ServerPicker>` in a file, with the one fact this test cares about. */
export function serverPickers(
  source: string,
): { text: string; portalOff: boolean }[] {
  const tree = ts.createSourceFile(
    "f.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: { text: string; portalOff: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      // `ServerPickerPanel` is a different component with no such prop.
      node.tagName.getText() === "ServerPicker"
    ) {
      found.push({ text: node.getText(), portalOff: portalOff(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
};

describe("ServerPicker inside a modal Dialog", () => {
  it("always receives inModal", () => {
    const offenders: string[] = [];

    for (const rel of readdirSync(CLIENT_SRC, { recursive: true })) {
      const file = String(rel);
      if (!file.endsWith(".tsx") || file.includes("__tests__")) continue;
      const source = readFileSync(join(CLIENT_SRC, file), "utf8");
      if (!source.includes("<ServerPicker")) continue;
      if (!source.includes("<DialogContent")) continue;

      for (const picker of serverPickers(source)) {
        if (!picker.portalOff) offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("what the scan above actually matches", () => {
  const first = (source: string) => serverPickers(source)[0];

  it("does not mistake ServerPickerPanel for the picker", () => {
    expect(
      serverPickers("<ServerPickerPanel tab={tab} onTabChange={setTab} />"),
    ).toEqual([]);
  });

  it("finds the picker whether the prop list wraps or not", () => {
    expect(
      serverPickers(`
      <>
        <ServerPicker projectId={id} inModal />
        <ServerPicker
          projectId={id}
        />
      </>
    `),
    ).toHaveLength(2);
  });

  it("counts the shorthand, the explicit true, and a forwarded prop", () => {
    // The composer passes `inModal={inModal}`; refusing that left every picker
    // reached through it unvouched for by a ratchet whose job is to vouch.
    expect(first("<ServerPicker inModal />").portalOff).toBe(true);
    expect(first("<ServerPicker inModal={true} />").portalOff).toBe(true);
    expect(first("<ServerPicker inModal={inModal} />").portalOff).toBe(true);
  });

  it("refuses a value that leaves the popover portaled, or that it cannot read", () => {
    expect(first("<ServerPicker inModal={false} />").portalOff).toBe(false);
    expect(first("<ServerPicker inModal={isNested} />").portalOff).toBe(false);
    expect(first("<ServerPicker inModal={a && b} />").portalOff).toBe(false);
    expect(first('<ServerPicker projectId="p" />').portalOff).toBe(false);
  });

  it("is not fooled by a prop whose name merely contains it", () => {
    // The text version anchored on `\b`, which a hyphen satisfies, so
    // `data-inModal` vouched for a picker holding no such prop.
    for (const prop of ["xinModal", "data-notinModal", "data-inModal"]) {
      expect(first(`<ServerPicker ${prop} />`).portalOff, prop).toBe(false);
    }
    expect(first('<ServerPicker aria-inModal="x" />').portalOff).toBe(false);
  });

  it("reads shapes the text scan got wrong", () => {
    // A prop holding its own JSX, the children form, and a template literal in
    // a prop: three separate defects in the hand-written scanner, none of them
    // a question the parser has to be told about.
    expect(
      first("<ServerPicker renderItem={(s) => <Row />} inModal />").portalOff,
    ).toBe(true);
    expect(
      first("<ServerPicker inModal>\n  <Child />\n</ServerPicker>").portalOff,
    ).toBe(true);
    expect(first("<ServerPicker title={`{`} inModal />").portalOff).toBe(true);
  });
});

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appTsxFiles, parseTsx, readAppFile } from "./support/client-tsx";

/**
 * `inModal` inside a Dialog, guarded by the compiler.
 *
 * The picker portals its popover by default; a modal Dialog's overlay then
 * swallows every click on it, and nothing throws. A missing prop is invisible
 * to type checking and to every DOM test that does not click through the real
 * popover — only reading the source catches it.
 *
 * Read through `typescript`: the hand-written version counted braces to find
 * where an element ended and got it wrong three times.
 *
 * SCOPE: nesting inside a `<DialogContent>` written in the SAME file, which is
 * the shape that actually regressed. A picker whose overlay comes from a
 * wrapper elsewhere passes unexamined — closing that needs the render tree.
 */
/**
 * Bare `inModal`, `={true}` and the forward `={inModal}` count — refusing the
 * forward left most pickers in the app unvouched for. Anything else is an
 * expression the source does not settle.
 */
function portalOff(element: ts.JsxOpeningLikeElement): boolean {
  const attr = element.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === "inModal",
  ) as ts.JsxAttribute | undefined;
  if (!attr) return false;
  if (!attr.initializer) return true;
  return /^\{\s*(?:true|inModal)\s*\}$/.test(attr.initializer.getText());
}

/** Is this element nested inside a `<DialogContent>`? */
function insideDialog(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (
      ts.isJsxElement(n) &&
      n.openingElement.tagName.getText() === "DialogContent"
    ) {
      return true;
    }
  }
  return false;
}

/** Every `<ServerPicker>` in a file, with the two facts this test cares about. */
export function serverPickers(
  source: string,
): { text: string; portalOff: boolean; inDialog: boolean }[] {
  const tree = parseTsx(source);
  const found: { text: string; portalOff: boolean; inDialog: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      // `ServerPickerPanel` is a different component with no such prop.
      node.tagName.getText() === "ServerPicker"
    ) {
      found.push({
        text: node.getText(),
        portalOff: portalOff(node),
        inDialog: insideDialog(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

describe("ServerPicker inside a modal Dialog written in the same file", () => {
  // Does NOT prove: that a forwarded `inModal={inModal}` is really true, or
  // that a composer placed in a dialog elsewhere is covered.
  it("receives inModal wherever the dialog is written beside it", () => {
    const offenders: string[] = [];

    for (const file of appTsxFiles()) {
      const source = readAppFile(file);
      if (!source.includes("<ServerPicker")) continue;

      for (const picker of serverPickers(source)) {
        // Nested inside the dialog, not merely sharing a file with one. The
        // text version asked the second question, so a correctly portalled
        // picker beside an unrelated Dialog failed the suite.
        if (picker.inDialog && !picker.portalOff) offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("what the scan above actually matches", () => {
  const first = (source: string) => serverPickers(source)[0];

  it("only judges a picker actually nested in a dialog", () => {
    const src = `
      <>
        <Dialog><DialogContent><ServerPicker inModal /></DialogContent></Dialog>
        <ServerPicker projectId={id} />
      </>
    `;
    const [inside, outside] = serverPickers(src);
    expect(inside.inDialog).toBe(true);
    // Shares the file with a Dialog but is not in it: portalling is correct.
    expect(outside.inDialog).toBe(false);
    expect(outside.portalOff).toBe(false);
  });

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
    // The composer forwards its own prop; refusing that vouches for nothing.
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
    // `\b` is satisfied by a hyphen, so `data-inModal` used to vouch.
    for (const prop of ["xinModal", "data-notinModal", "data-inModal"]) {
      expect(first(`<ServerPicker ${prop} />`).portalOff, prop).toBe(false);
    }
    expect(first('<ServerPicker aria-inModal="x" />').portalOff).toBe(false);
  });

  it("reads shapes the text scan got wrong", () => {
    // Three separate defects in the hand-written scanner.
    expect(
      first("<ServerPicker renderItem={(s) => <Row />} inModal />").portalOff,
    ).toBe(true);
    expect(
      first("<ServerPicker inModal>\n  <Child />\n</ServerPicker>").portalOff,
    ).toBe(true);
    expect(first("<ServerPicker title={`{`} inModal />").portalOff).toBe(true);
  });
});

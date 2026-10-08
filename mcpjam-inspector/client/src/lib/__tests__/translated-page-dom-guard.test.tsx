import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTranslatedPageDomGuard } from "../translated-page-dom-guard";

// What Chrome/Edge page translation does: pull each text node out and put a
// translated `<font>` in its place. React keeps pointing at the old node.
function translate(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const text of textNodes) {
    const font = document.createElement("font");
    font.textContent = `[pt] ${text.data}`;
    text.parentNode!.replaceChild(font, text);
  }
}

function Message({ streaming }: { streaming: boolean }) {
  return (
    <div>
      {streaming ? "Thinking" : null}
      <span>Reply</span>
    </div>
  );
}

describe("translated page DOM guard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("without the guard, React crashes removing a translated text node", () => {
    act(() => root.render(<Message streaming />));
    translate(container);

    expect(() => act(() => root.render(<Message streaming={false} />))).toThrow(
      /not a child/,
    );
  });

  it("with the guard, React updates a translated page without crashing", () => {
    const uninstall = installTranslatedPageDomGuard();
    try {
      act(() => root.render(<Message streaming />));
      translate(container);

      expect(() =>
        act(() => root.render(<Message streaming={false} />)),
      ).not.toThrow();
      expect(container.querySelector("span")?.textContent).toBe("[pt] Reply");
    } finally {
      uninstall();
    }
  });

  it("still removes and inserts nodes normally", () => {
    const uninstall = installTranslatedPageDomGuard();
    try {
      const parent = document.createElement("div");
      const a = document.createElement("a");
      const b = document.createElement("b");
      parent.appendChild(b);

      parent.insertBefore(a, b);
      expect([...parent.childNodes]).toEqual([a, b]);

      parent.removeChild(a);
      expect([...parent.childNodes]).toEqual([b]);
    } finally {
      uninstall();
    }
  });
});

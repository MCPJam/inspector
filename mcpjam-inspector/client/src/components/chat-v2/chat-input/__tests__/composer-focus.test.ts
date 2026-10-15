import { afterEach, describe, expect, it } from "vitest";
import { focusChatComposer } from "../composer-focus";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusChatComposer", () => {
  it("focuses the first composer that can take focus", () => {
    document.body.innerHTML = `
      <form hidden><textarea data-chat-composer-input id="hidden"></textarea></form>
      <textarea data-chat-composer-input id="disabled" disabled></textarea>
      <textarea id="other"></textarea>
      <textarea data-chat-composer-input id="composer"></textarea>`;
    expect(focusChatComposer(document.body)).toBe(true);
    expect(document.activeElement?.id).toBe("composer");
  });

  it("does nothing without a composer it can focus", () => {
    document.body.innerHTML = `<form hidden><textarea data-chat-composer-input></textarea></form>`;
    expect(focusChatComposer(document.body)).toBe(false);
    expect(focusChatComposer(null)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

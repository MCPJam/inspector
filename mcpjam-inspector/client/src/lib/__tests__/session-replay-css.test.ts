// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { record } from "posthog-js/dist/rrweb";
import { MASKED_SESSION_RECORDING_OPTIONS } from "../session-privacy/posthog-replay";

type SerializedNode = {
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: SerializedNode[];
};

function find(
  node: SerializedNode,
  match: (n: SerializedNode) => boolean,
): SerializedNode | undefined {
  if (match(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = find(child, match);
    if (found) return found;
  }
  return undefined;
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("masked replay with posthog-js's recorder", () => {
  it("keeps stylesheet text and masks page text and attributes", () => {
    const style = document.createElement("style");
    document.head.appendChild(style);
    style.sheet?.insertRule(".flex { display: flex; }");
    document.body.innerHTML =
      '<div class="flex" title="acme-billing">Summarise my chat</div>';

    const events: Array<{ type: number; data: { node?: SerializedNode } }> = [];
    const stop = record({
      ...MASKED_SESSION_RECORDING_OPTIONS,
      emit: (event) => {
        events.push(event as (typeof events)[number]);
      },
    });
    stop?.();

    const snapshot = events.find((event) => event.type === 2)?.data.node;
    expect(snapshot).toBeDefined();
    const styleNode = find(snapshot!, (n) => n.tagName === "style");
    expect(styleNode?.attributes?._cssText).toContain("display: flex");
    const div = find(snapshot!, (n) => n.tagName === "div");
    expect(div?.attributes?.class).toBe("flex");
    expect(div?.attributes?.title).toBe("***");
    const text = find(div!, (n) => typeof n.textContent === "string");
    expect(text?.textContent).toBe("********* ** ****");
  });
});

import { describe, expect, it } from "vitest";
import {
  addressFieldTarget,
  addressFieldValue,
  EMPTY_ADDRESS_FIELD,
  isEditing,
  reduceAddressField,
  type AddressFieldEvent,
  type AddressFieldState,
} from "../address-field";

function run(
  events: AddressFieldEvent[],
  from: AddressFieldState = EMPTY_ADDRESS_FIELD,
): AddressFieldState {
  return events.reduce(reduceAddressField, from);
}

describe("what the field shows", () => {
  it("shows the host at rest", () => {
    const state = run([
      { type: "url", url: "https://example.com/reset?token=abc123" },
    ]);
    expect(addressFieldValue(state)).toBe("example.com");
  });

  it("shows the whole url when focused", () => {
    const state = run([
      { type: "url", url: "https://example.com/reset?token=abc123" },
      { type: "focus" },
    ]);
    expect(addressFieldValue(state)).toBe(
      "https://example.com/reset?token=abc123",
    );
  });

  it("goes back to the host on blur", () => {
    const state = run([
      { type: "url", url: "https://example.com/a/b" },
      { type: "focus" },
      { type: "blur" },
    ]);
    expect(addressFieldValue(state)).toBe("example.com");
  });

  it("keeps the port, because localhost:3000 and :5173 are two apps", () => {
    const state = run([{ type: "url", url: "http://localhost:3000/app" }]);
    expect(addressFieldValue(state)).toBe("localhost:3000");
  });
});

describe("an edit survives the browser moving underneath it", () => {
  it("does not overwrite a draft when the page navigates", () => {
    // The bug this exists to prevent: an agent navigating mid-word deletes
    // what somebody is typing.
    let state = run([
      { type: "url", url: "https://a.test/" },
      { type: "focus" },
      { type: "edit", value: "exa" },
    ]);
    state = reduceAddressField(state, {
      type: "url",
      url: "https://agent-went-here.test/",
    });
    expect(addressFieldValue(state)).toBe("exa");
  });

  it("does not overwrite a draft on a redirect settling", () => {
    let state = run([
      { type: "url", url: "https://a.test/" },
      { type: "focus" },
      { type: "edit", value: "my-site.com/page" },
    ]);
    for (const url of [
      "https://a.test/redirect/1",
      "https://a.test/redirect/2",
      "https://final.test/",
    ]) {
      state = reduceAddressField(state, { type: "url", url });
    }
    expect(addressFieldValue(state)).toBe("my-site.com/page");
  });

  it("snaps to whatever the browser has been saying once the draft is gone", () => {
    let state = run([
      { type: "url", url: "https://a.test/" },
      { type: "focus" },
      { type: "edit", value: "half-typed" },
    ]);
    state = reduceAddressField(state, {
      type: "url",
      url: "https://moved.test/",
    });
    state = reduceAddressField(state, { type: "cancel" });
    // Focused, so the whole URL — and the one that arrived while editing.
    expect(addressFieldValue(state)).toBe("https://moved.test/");
  });
});

describe("committing and abandoning", () => {
  it("hands back a normalized url on commit", () => {
    const state = run([
      { type: "url", url: "https://a.test/" },
      { type: "focus" },
      { type: "edit", value: "  localhost:3000/x " },
    ]);
    expect(addressFieldTarget(state)).toBe("http://localhost:3000/x");
    expect(
      addressFieldValue(reduceAddressField(state, { type: "commit" })),
    ).toBe("https://a.test/");
  });

  it("searches for ordinary text", () => {
    const state = run([
      { type: "focus" },
      { type: "edit", value: "how do I center a div" },
    ]);
    expect(addressFieldTarget(state)).toBe(
      "https://www.google.com/search?q=how+do+I+center+a+div",
    );
  });

  it("hands back nothing when there is no draft at all", () => {
    expect(
      addressFieldTarget(run([{ type: "url", url: "https://a.test/" }])),
    ).toBeNull();
  });

  it("clears the draft on commit even when it was not navigable", () => {
    // Leaving the text in the field would leave the field disagreeing with the
    // page for as long as somebody left it alone.
    const state = run([
      { type: "url", url: "https://a.test/" },
      { type: "focus" },
      { type: "edit", value: "nonsense" },
      { type: "commit" },
    ]);
    expect(isEditing(state)).toBe(false);
    expect(addressFieldValue(state)).toBe("https://a.test/");
  });

  it("abandons the draft on Escape and on blur alike", () => {
    for (const ending of ["cancel", "blur"] as const) {
      const state = run([
        { type: "url", url: "https://a.test/" },
        { type: "focus" },
        { type: "edit", value: "half" },
        { type: ending },
      ]);
      expect(isEditing(state)).toBe(false);
    }
  });
});

describe("focus is not an edit", () => {
  it("reading the full url does not start a draft", () => {
    // Checking where the agent went should not require pressing Escape to
    // leave the field alone.
    const state = run([
      { type: "url", url: "https://a.test/deep" },
      { type: "focus" },
    ]);
    expect(isEditing(state)).toBe(false);
    expect(addressFieldTarget(state)).toBeNull();
  });

  it("still follows the browser while focused but not edited", () => {
    const state = run([
      { type: "url", url: "https://a.test/" },
      { type: "focus" },
      { type: "url", url: "https://b.test/" },
    ]);
    expect(addressFieldValue(state)).toBe("https://b.test/");
  });
});

describe("identity", () => {
  it("returns the same object when nothing moved", () => {
    const state = run([{ type: "url", url: "https://a.test/" }]);
    expect(
      reduceAddressField(state, { type: "url", url: "https://a.test/" }),
    ).toBe(state);
    expect(reduceAddressField(state, { type: "blur" })).toBe(state);
    expect(reduceAddressField(state, { type: "cancel" })).toBe(state);
  });
});

it.each([
  ["localhost:3000", "http://localhost:3000/"],
  ["example.com/path", "https://example.com/path"],
  ["settings", "https://www.google.com/search?q=settings"],
  ["café & tea", "https://www.google.com/search?q=caf%C3%A9+%26+tea"],
  ["javascript:alert(1)", null],
  ["file:///etc/passwd", null],
  ["   ", null],
])(
  "classifies %s without sending search text to the daemon",
  (value, target) => {
    expect(addressFieldTarget(run([{ type: "edit", value }]))).toBe(target);
  },
);

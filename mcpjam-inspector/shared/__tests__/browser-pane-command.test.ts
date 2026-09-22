import { describe, expect, it } from "vitest";
import {
  addressAtRest,
  anchorStillValid,
  gestureAcquires,
  normalizePaneUrl,
  takeoverRefusedNotice,
  type InteractionAnchor,
} from "../browser-pane-command";

describe("gestureAcquires", () => {
  it("takes control on input and on a command", () => {
    expect(gestureAcquires("input")).toBe(true);
    expect(gestureAcquires("command")).toBe(true);
  });

  it("does not take control on hovering, reading the address, or resizing", () => {
    // Taking control on a hover stops the agent because somebody moved their
    // mouse across the window on the way to the chat box.
    expect(gestureAcquires("hover")).toBe(false);
    expect(gestureAcquires("read_address")).toBe(false);
    expect(gestureAcquires("resize")).toBe(false);
  });
});

describe("anchorStillValid", () => {
  const before: InteractionAnchor = {
    tabId: "t1",
    url: "https://example.com/a",
    navCounter: 4,
  };

  it("accepts an unmoved page", () => {
    expect(anchorStillValid(before, { ...before })).toBe(true);
  });

  it("rejects a navigation that landed during the acquire", () => {
    expect(
      anchorStillValid(before, { ...before, url: "https://example.com/b" }),
    ).toBe(false);
  });

  it("rejects a reload that kept the same url", () => {
    expect(anchorStillValid(before, { ...before, navCounter: 5 })).toBe(false);
  });

  it("rejects a tab switch", () => {
    expect(anchorStillValid(before, { ...before, tabId: "t2" })).toBe(false);
  });

  it("treats an unreadable state as changed", () => {
    // "We could not check" is not evidence that nothing moved.
    expect(anchorStillValid(before, null)).toBe(false);
    expect(anchorStillValid(before, undefined)).toBe(false);
  });
});

describe("normalizePaneUrl", () => {
  it("accepts the forms people type", () => {
    expect(normalizePaneUrl("example.com")).toBe("https://example.com/");
    expect(normalizePaneUrl("  https://example.com/a?b=1  ")).toBe(
      "https://example.com/a?b=1",
    );
    expect(normalizePaneUrl("http://example.com")).toBe("http://example.com/");
  });

  it("accepts localhost with and without a port", () => {
    // The single most common thing anybody types into this browser.
    expect(normalizePaneUrl("localhost:3000")).toBe("http://localhost:3000/");
    // Loopback is loopback with or without a port: there is no certificate
    // either way, so the schemeless default is http for both.
    expect(normalizePaneUrl("localhost")).toBe("http://localhost/");
    expect(normalizePaneUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    // An explicit scheme still wins.
    expect(normalizePaneUrl("https://localhost:8443")).toBe(
      "https://localhost:8443/",
    );
    expect(normalizePaneUrl("http://127.0.0.1:8080/x")).toBe(
      "http://127.0.0.1:8080/x",
    );
  });

  it("accepts an explicit port on a bare host, over https", () => {
    // Guessing http for a non-loopback host would be a silent downgrade;
    // somebody on a plain-http dev box types the scheme.
    expect(normalizePaneUrl("dev-box:5173")).toBe("https://dev-box:5173/");
    expect(normalizePaneUrl("http://dev-box:5173")).toBe(
      "http://dev-box:5173/",
    );
  });

  it("refuses a bare word that is not a place", () => {
    expect(normalizePaneUrl("settings")).toBeNull();
    expect(normalizePaneUrl("readme")).toBeNull();
  });

  it("refuses the schemes that are not a page a person asked for", () => {
    expect(normalizePaneUrl("file:///etc/passwd")).toBeNull();
    expect(normalizePaneUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePaneUrl("data:text/html,<h1>x</h1>")).toBeNull();
    expect(normalizePaneUrl("chrome://settings")).toBeNull();
  });

  it("refuses empty input", () => {
    expect(normalizePaneUrl("")).toBeNull();
    expect(normalizePaneUrl("   ")).toBeNull();
  });

  it("is not a search box", () => {
    // Quietly shipping a sentence to a third party is a default nobody chose.
    expect(normalizePaneUrl("how do I center a div")).toBeNull();
  });
});

describe("addressAtRest", () => {
  it("shows the host, not the path", () => {
    expect(addressAtRest("https://example.com/reset?token=abc123")).toBe(
      "example.com",
    );
  });

  it("keeps the port, because it is part of the identity here", () => {
    expect(addressAtRest("http://localhost:3000/app")).toBe("localhost:3000");
    expect(addressAtRest("http://localhost:5173/app")).toBe("localhost:5173");
  });

  it("passes through something it cannot parse", () => {
    expect(addressAtRest("about:blank")).toBe("about:blank");
    expect(addressAtRest("")).toBe("");
  });
});

describe("takeoverRefusedNotice", () => {
  it("names which kind of holder", () => {
    expect(takeoverRefusedNotice({ kind: "script" })).toMatch(/script/i);
    expect(takeoverRefusedNotice({ kind: "human" })).toMatch(/someone else/i);
  });
});

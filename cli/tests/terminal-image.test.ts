import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectInlineImageProtocol,
  encodeInlineImage,
} from "../src/lib/terminal-image.js";

test("detects Kitty-family terminals", () => {
  assert.equal(
    detectInlineImageProtocol({ TERM: "xterm-kitty" }, true),
    "kitty",
  );
  assert.equal(
    detectInlineImageProtocol({ KITTY_WINDOW_ID: "1" }, true),
    "kitty",
  );
  assert.equal(
    detectInlineImageProtocol({ TERM_PROGRAM: "ghostty" }, true),
    "kitty",
  );
});

test("detects iTerm-family terminals", () => {
  assert.equal(
    detectInlineImageProtocol({ TERM_PROGRAM: "iTerm.app" }, true),
    "iterm",
  );
  assert.equal(
    detectInlineImageProtocol({ TERM_PROGRAM: "WezTerm" }, true),
    "iterm",
  );
  assert.equal(
    detectInlineImageProtocol({ LC_TERMINAL: "iTerm2" }, true),
    "iterm",
  );
});

test("returns null for unknown terminals and non-TTY streams", () => {
  assert.equal(detectInlineImageProtocol({ TERM: "xterm-256color" }, true), null);
  // Even a capable terminal yields null when output is not a TTY (pipe/CI).
  assert.equal(detectInlineImageProtocol({ TERM: "xterm-kitty" }, false), null);
  assert.equal(
    detectInlineImageProtocol({ TERM_PROGRAM: "iTerm.app" }, undefined),
    null,
  );
});

test("encodes an iTerm2 OSC 1337 inline image", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const seq = encodeInlineImage(data, "iterm");
  const base64 = Buffer.from(data).toString("base64");
  assert.equal(seq.startsWith("\x1b]1337;File="), true);
  assert.equal(seq.includes("inline=1"), true);
  assert.equal(seq.includes("size=4"), true);
  assert.equal(seq.includes(`:${base64}\x07`), true);
});

test("encodes a Kitty graphics image and chunks large payloads", () => {
  const small = encodeInlineImage(new Uint8Array([1, 2, 3]), "kitty");
  assert.equal(small.startsWith("\x1b_G"), true);
  assert.equal(small.includes("a=T,f=100"), true);
  assert.equal(small.includes("m=0"), true); // single chunk → final
  assert.equal(small.includes("\x1b\\"), true);

  // 6KB of bytes → > 4096 base64 chars → multiple chunks, first m=1, last m=0.
  const big = encodeInlineImage(new Uint8Array(6000).fill(7), "kitty");
  const chunks = big.split("\x1b_G").length - 1;
  assert.equal(chunks > 1, true);
  assert.equal(big.includes("m=1"), true);
  assert.match(big, /m=0;[^\x1b]*\x1b\\\n$/);
});

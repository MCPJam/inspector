import { describe, it, expect } from "vitest";
import {
  formatPath,
  highlightJson,
  tokenizeJson,
} from "../json-syntax-highlighter";

/**
 * The tokenizer itself is tested in `@mcpjam/chat-ui`, where it lives
 * (`chat-ui/src/__tests__/json-tokens.test.ts`). What is worth checking HERE
 * is the seam: that this module still hands the editor working functions after
 * the move, and that the subpath alias resolves in the client's vitest config.
 * A broken re-export would otherwise surface as a confusing failure deep in
 * `json-editor-edit` or `truncatable-string`.
 */
describe("json-syntax-highlighter re-export", () => {
  it("forwards the tokenizer", () => {
    const tokens = tokenizeJson('{"a": 1}');
    expect(tokens.map((token) => token.type)).toEqual([
      "punctuation",
      "key",
      "punctuation",
      "number",
      "punctuation",
    ]);
  });

  it("forwards highlightJson, which the edit view feeds to the DOM", () => {
    expect(highlightJson('{"a": 1}')).toContain('<span class="json-key">');
  });

  it("forwards formatPath, which truncatable-string labels values with", () => {
    expect(formatPath(["users", 0, "name"])).toBe("users[0].name");
  });
});

/**
 * The JSON tokenizer now lives in `@mcpjam/chat-ui`, because the Sessions
 * transcript needs the same token stream this editor does and one of them had
 * to be the source (BB-239).
 *
 * Imported from the `json-tokens` subpath, not the package barrel: these are
 * three pure functions, and the barrel would pull React, lucide and the
 * markdown tree into the editor's import graph and into its unit tests.
 *
 * Kept as a re-export so the editor's own call sites — `json-editor-edit.tsx`,
 * `json-highlighter.tsx`, `truncatable-string.tsx` — do not have to care where
 * it went.
 */
export {
  formatPath,
  highlightJson,
  tokenizeJson,
  type Token,
  type TokenType,
} from "@mcpjam/chat-ui/json-tokens";

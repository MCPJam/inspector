/**
 * The JSON tokenizer now lives in `@mcpjam/chat-ui` (Tier A), because the
 * Sessions transcript needs exactly the same token stream this editor does.
 *
 * Kept as a re-export rather than updating ~6 call sites: this path is the
 * json-editor's own internal module boundary, and the point of the move is
 * that there is ONE tokenizer, not that every consumer learns where it now
 * lives. `@mcpjam/chat-ui` resolves to source via the client vite alias, so
 * this costs no build ordering.
 */
export {
  formatPath,
  highlightJson,
  tokenizeJson,
  type Token,
  type TokenType,
} from "@mcpjam/chat-ui";

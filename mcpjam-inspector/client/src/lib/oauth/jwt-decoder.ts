// The JWT decoders are single-sourced in @mcpjam/sdk (browser-safe). Re-exported
// here so existing `@/lib/oauth/jwt-decoder` importers keep their path.
export {
  decodeJWT,
  decodeJWTParts,
  formatJWTTimestamp,
} from "@mcpjam/sdk/browser";
export type { DecodedJwtParts } from "@mcpjam/sdk/browser";

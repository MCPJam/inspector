/**
 * `@mcpjam/sdk/host-config/templates` — Node-safe host-template seeding.
 *
 * Public entry for seeding a host config from a built-in template id (the
 * server's `--template` resolver and the CLI use this). Kept OUT of the
 * backend-shared `host-config/internal` barrel so importing the canonicalizer
 * doesn't drag template/seed code into the Convex backend.
 *
 * UI-only template metadata (logos, labels) stays in the inspector client; the
 * client re-exports `seedHostTemplate` from here so seed logic has one source.
 */

export {
  seedHostTemplate,
  seedFromHostTemplate,
  HOST_TEMPLATES,
  HOST_TEMPLATE_IDS,
  DEFAULT_HOST_TEMPLATE_ID,
  CLAUDE_CODE_NATIVE_TOOLS,
} from "./seed-host-template.js";
export type {
  HostTemplate,
  HostTemplateId,
  SeedHostTemplateOptions,
} from "./seed-host-template.js";
export {
  emptyHostConfigInputV2,
  DEFAULT_HOST_STYLE_V2,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type SeededHostConfigInput,
} from "./empty-input.js";
export {
  getMcpJamStyleVariables,
  MCPJAM_FONT_CSS,
  MCPJAM_PLATFORM,
} from "./mcpjam-style.js";
export { getMistralStyleVariables } from "./mistral-style.js";

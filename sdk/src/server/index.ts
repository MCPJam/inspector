/**
 * Building blocks for an MCP server, shared by MCPJam's mock servers and its
 * hosted MCP server. Safe on Node and on Workers: nothing here uses a Node API
 * or compiles code, and a JSON Schema validator is passed in where one is
 * needed.
 */
export {
  MODERN_REVISION,
  capabilitiesForRevision,
  revisionOf,
} from "./revision.js";
export { pageOf } from "./paging.js";
export type { PageOptions } from "./paging.js";
export { matchTemplate, templateVariables } from "./uri-template.js";
export {
  SKILLS_EXTENSION_ID,
  registerSkillsMethods,
  skillManifestEntry,
  skillNotFoundError,
  skillsCapability,
} from "./skills.js";
export type { SkillsCachePolicy, SkillsSource } from "./skills.js";
export {
  checkStructuredOutput,
  compileOutputSchema,
} from "./output-schema.js";
export type {
  CompileOutputSchema,
  CompiledOutputSchema,
  OutputVerdict,
  ValidateOutput,
} from "./output-schema.js";

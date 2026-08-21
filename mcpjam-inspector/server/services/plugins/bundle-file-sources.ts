/**
 * Re-export shim for the Node `PluginFileSource` adapters.
 *
 * The implementations moved to `@mcpjam/sdk`'s Node entry
 * (`plugin-bundle/node-file-sources.ts`) so the CLI's local package modes can
 * use them without depending on this server. The alternative was a second copy
 * of the archive rules the OpenAI package lane grades — the "mirror the SDK"
 * mistake this codebase has made once already, and the one whose symptom is
 * two implementations quietly disagreeing about the same ZIP.
 *
 * This file stays so the server's existing importers keep compiling. New code
 * should import from `@mcpjam/sdk` directly; this is a gradual move rather
 * than a flag day.
 */
export {
  DIRECTORY_ARCHIVE_OBSERVATIONS,
  collectZipArchiveObservations,
  createDirectoryPluginFileSource,
  createZipPluginFileSource,
} from "@mcpjam/sdk";

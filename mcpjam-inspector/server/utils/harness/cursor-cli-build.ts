/**
 * The Cursor CLI build hosted Cursor installs and the local pack carries.
 *
 * A leaf on purpose. The layer bundler loads the Cursor bridge's recipe in the
 * pack workflow, where nothing has built the SDK, and `shared/harness-descriptors`
 * imports the SDK's build, so a module on that path can't read the pin from
 * there. `cursor-runtime.test.ts` ties this to the descriptor's pin and to the
 * builds the pack recipe downloads; `layer-bundler-loads.test.ts` fails if the
 * bridge's recipe reaches the SDK again.
 */
export const CURSOR_CLI_BUILD = "2026.11.05-86047df";

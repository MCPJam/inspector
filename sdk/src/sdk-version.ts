/** Injected by tsup/vitest `define` (see `sdk/tsup.config.ts`). */
declare const __MCPJAM_SDK_VERSION__: string;

/**
 * Read the injected version WITHOUT assuming the injection happened.
 *
 * Modules that call this are reachable from the browser entry, and the
 * inspector's Vite build aliases `@mcpjam/sdk/browser` straight to
 * `src/browser.ts` — so it compiles them from SOURCE, with no `define` of its
 * own. A bare `__MCPJAM_SDK_VERSION__` reference then survives into the client
 * bundle as an undeclared global and throws `ReferenceError` at module init,
 * which takes the whole app down before React mounts. (It did: every Playwright
 * smoke test failed on a missing app shell.)
 *
 * `typeof` on an undeclared identifier is the one read that cannot throw, so a
 * consumer that bundles this from source degrades to `"unknown"` instead of
 * crashing. `"unknown"` is deliberate rather than a plausible-looking version:
 * a stamp claiming a version nobody injected would be worse than one admitting
 * it does not know.
 */
export function readSdkVersion(): string {
  return typeof __MCPJAM_SDK_VERSION__ === "string"
    ? __MCPJAM_SDK_VERSION__
    : "unknown";
}

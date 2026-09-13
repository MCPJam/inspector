/**
 * Compile-time constants injected by `@electron-forge/plugin-vite`.
 *
 * These are NOT environment variables and NOT globals that exist at runtime.
 * The plugin's `getBuildDefine` (its `config/vite.base.config.ts`) adds them to
 * Vite's `define` map, so each reference is textually substituted when the main
 * bundle is built — and only for `command === 'serve'`. For a packaging build
 * the define's value is `undefined`, which can leave the identifier entirely
 * free in the emitted bundle.
 *
 * That is why every read must be guarded with `typeof`:
 *
 * ```ts
 * typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string"  // safe, always
 * MAIN_WINDOW_VITE_DEV_SERVER_URL                      // ReferenceError risk
 * ```
 *
 * `typeof` on an undeclared identifier is the one JavaScript operation that
 * cannot throw; a bare reference takes down the packaged app at module load.
 * The declarations below are therefore deliberately `| undefined` so the
 * compiler requires that guard. The plugin ships its own
 * `forge-vite-env.d.ts` typing them as bare `string`, which is a lie on the
 * packaging path — `src/main.ts` references this file instead of that one.
 * (That shipped file is largely inert anyway: its `import type` points at
 * `./src/Config`, while the published type actually lives at `./dist/Config`.)
 *
 * `src/main.ts` funnels all of this through one read, `rendererDevServerUrl`.
 * Prefer that over touching these constants again.
 */
declare global {
  /**
   * Origin of forge's renderer Vite dev server, e.g. `http://localhost:5173`.
   * A non-empty string here is the authoritative "this is a dev run" signal.
   */
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  /** Renderer build name (`main_window`), used to locate packaged renderer assets. */
  const MAIN_WINDOW_VITE_NAME: string | undefined;
}

export {};

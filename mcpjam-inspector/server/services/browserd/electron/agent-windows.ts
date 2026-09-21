/**
 * Which `BrowserWindow`s belong to the agent rather than to the person.
 *
 * IMPORT-FREE ON PURPOSE, and that is the whole reason this is its own file.
 * `src/main.ts` needs to ask this question in its `activate` and window-close
 * handlers, and its own header forbids reaching into the server graph at
 * module-load time — importing `electron-context.ts` would drag in the page,
 * the CDP adapter and, through it, `utils/logger.ts`, which initialises Sentry
 * and Axiom as a side effect of being loaded. A second Sentry in the Electron
 * main process is not a thing to acquire by accident.
 *
 * WHY THE QUESTION EXISTS. The agent browser opens real `BrowserWindow`s —
 * hidden, but windows all the same — so Electron counts them. An open agent tab
 * therefore meant `window-all-closed` never fired (on Windows and Linux the app
 * never quit) and `activate`'s zero-window check never passed (on macOS a dock
 * click rebuilt nothing, leaving the app running with no way to reach its UI).
 *
 * Process-wide rather than per-context: the app is asking about the PROCESS,
 * and it has no reason to know how many contexts happen to exist.
 */

const agentWindowIds = new Set<number>();

/** Record a window the agent opened. */
export function rememberAgentWindow(id: number | undefined): void {
  if (typeof id === "number") agentWindowIds.add(id);
}

/** Forget one, on close or on teardown. */
export function forgetAgentWindow(id: number | undefined): void {
  if (typeof id === "number") agentWindowIds.delete(id);
}

/** Is this window one the agent opened, rather than one a person can see? */
export function isAgentBrowserWindow(window: { id?: number }): boolean {
  return typeof window.id === "number" && agentWindowIds.has(window.id);
}

/** How many hidden agent windows are open right now. */
export function agentBrowserWindowCount(): number {
  return agentWindowIds.size;
}

/** Test seam: this registry is process-wide by design. */
export function resetAgentWindowsForTests(): void {
  agentWindowIds.clear();
}

import { useAuth } from "@workos-inc/authkit-react";

/**
 * Electron-aware wrapper for WorkOS AuthKit authentication
 *
 * Navigation to AuthKit URLs is intercepted in the Electron main process
 * (see src/main.ts will-navigate event) and opened in external browser.
 *
 * This hook simply passes through to the regular AuthKit methods,
 * which will trigger navigation that gets intercepted by Electron.
 */
export function useElectronAuth() {
  const auth = useAuth();

  // In Electron, navigation to WorkOS URLs is automatically intercepted
  // by the main process (see src/main.ts) and opened in external browser.
  // So we can just use the normal auth methods.

  return auth;
}

/**
 * Module-level holder for the app's React Router instance.
 *
 * Kept in its own tiny module so non-React callers (`navigateApp` in
 * `lib/app-navigation.ts`, the IPC bridge in `App.tsx`, OAuth-resume
 * callers) can read the router without transitively importing `App.tsx`.
 * Importing `router.tsx` would pull in the entire app component tree,
 * which leaks into test mock chains.
 */
import type { createBrowserRouter } from "react-router";

type AppRouter = ReturnType<typeof createBrowserRouter>;

let routerRef: AppRouter | null = null;

export function getAppRouter(): AppRouter | null {
  return routerRef;
}

export function setAppRouter(router: AppRouter | null): void {
  routerRef = router;
}

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";

const pluginExtensionAccessQuery = makeFunctionReference<
  "query",
  { projectId: string },
  { enabled: boolean }
>("plugins:getPluginExtensionAccess");

export type PluginExtensionsAccessStatus =
  | "skipped"
  | "loading"
  | "ready"
  | "unavailable";

export interface PluginExtensionsAccess {
  /** True only when the backend admitted this project. */
  enabled: boolean;
  status: PluginExtensionsAccessStatus;
}

/**
 * Backend admission for OpenAI plugin extensions in a project.
 *
 * A deployment that doesn't have `plugins:getPluginExtensionAccess` yet
 * (flag on, backend behind) must render the Playground with extensions off,
 * not crash it, so a query error is caught and read as "off", leaving one
 * entry in the Logs panel.
 */
export function usePluginExtensionsAccess(input: {
  /** The `plugin-extensions-enabled` rollout flag. */
  flag: boolean;
  isAuthenticated: boolean;
  projectId: string | null | undefined;
}): PluginExtensionsAccess {
  const { flag, isAuthenticated, projectId } = input;
  const shouldQuery = flag && isAuthenticated && !!projectId;
  let result: { enabled?: unknown } | undefined;
  let error: Error | null = null;
  try {
    // `useQuery` rethrows a server error (including "function not found")
    // during render. Its own hooks have already run by then, so catching
    // here keeps the hook order stable while turning the error into "off".
    result = useQuery(
      pluginExtensionAccessQuery,
      shouldQuery && projectId ? { projectId } : "skip",
    ) as { enabled?: unknown } | undefined;
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  const errorMessage = error?.message ?? null;

  useEffect(() => {
    if (errorMessage === null || !projectId) return;
    logPluginExtensionIssue({
      code: "PLUGIN_EXTENSIONS_ACCESS_UNAVAILABLE",
      level: "warning",
      message:
        "Plugin extensions are off because this deployment couldn't confirm " +
        "access for the project. The backend may not support them yet.",
      detail: { projectId, error: errorMessage },
      dedupeKey: `access:${projectId}`,
    });
  }, [errorMessage, projectId]);

  if (!shouldQuery) return { enabled: false, status: "skipped" };
  if (error) return { enabled: false, status: "unavailable" };
  if (result === undefined) return { enabled: false, status: "loading" };
  return { enabled: result?.enabled === true, status: "ready" };
}

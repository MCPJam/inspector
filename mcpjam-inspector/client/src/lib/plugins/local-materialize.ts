/**
 * Seed the desktop runtime's verified bundle cache with the archive an import
 * just produced (INS-6).
 *
 * WHY THE CLIENT SENDS BYTES AT ALL: the backend stores every ready bundle,
 * but exposes no authorized read for its content today, so on a desktop
 * machine the import the user just performed is the only source available.
 * Nothing here is trusted — the request states the backend's pinned
 * `bundleHash` and the server refuses any archive that does not hash to it, so
 * a wrong or tampered ZIP can only produce a rejected request, never a
 * launchable entry.
 *
 * The local folder path is NOT sent and never persisted: the cache is keyed by
 * (project, plugin version, bundle hash), all of which the backend owns.
 *
 * Hosted web skips this entirely — there is no local process to materialize
 * for, which is what `local_runtime_required` reports on that surface.
 */
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";

export interface MaterializePluginBundleArgs {
  projectId: string;
  pluginVersionId: string;
  bundleHash: string;
  /** The same ZIP that was uploaded for the import. */
  zipBytes: Uint8Array;
}

export interface MaterializePluginBundleResult {
  materialized: boolean;
  /** Present when the runtime refused; surfaced as a non-fatal warning. */
  error?: string;
}

export async function materializePluginBundleLocally(
  args: MaterializePluginBundleArgs
): Promise<MaterializePluginBundleResult> {
  if (HOSTED_MODE) return { materialized: false };

  const form = new FormData();
  form.set("projectId", args.projectId);
  form.set("pluginVersionId", args.pluginVersionId);
  form.set("bundleHash", args.bundleHash);
  form.set(
    "bundle",
    new File([args.zipBytes as BlobPart], "bundle.zip", {
      type: "application/zip",
    })
  );

  const response = await authFetch("/api/mcp/plugins/materialize", {
    method: "POST",
    body: form,
  });
  if (response.ok) return { materialized: true };

  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return {
    materialized: false,
    error: body?.error ?? `Materialization failed (${response.status})`,
  };
}

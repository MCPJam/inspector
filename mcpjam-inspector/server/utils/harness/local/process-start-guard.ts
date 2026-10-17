import { revalidateRuntime, type ResolvedRuntime } from "./runtime-identity.js";

export function createLocalProcessStartGuard(runtime: ResolvedRuntime) {
  let forbidden = false;
  return {
    // Adoption is irreversible for this provider. A dead bridge changes the
    // park record to terminal, but still must not allow the adapter to rerun.
    forbidNewProcesses: () => {
      forbidden = true;
    },
    async assertCanStart(): Promise<void> {
      if (forbidden) {
        throw new Error(
          "The local runtime holding this approval could not be reattached; the pending action will not run.",
        );
      }
      // Availability checked the bundle once, but it can be replaced while a
      // session is alive. Verify again immediately before every process start.
      const result = await revalidateRuntime(runtime);
      if (!result.ok) {
        throw new Error(
          `refusing to launch: ${result.message}. Local execution is bound to ` +
            `a runtime identity, so a changed runtime needs fresh consent.`,
        );
      }
      if (forbidden) {
        throw new Error(
          "The local runtime holding this approval could not be reattached; the pending action will not run.",
        );
      }
    },
  };
}

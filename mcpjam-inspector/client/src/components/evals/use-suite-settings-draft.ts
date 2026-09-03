/**
 * Committing a settings draft: one mutation, one toast, one revision.
 *
 * The hook exists to hold three things the reducer cannot: the mutation, the
 * concurrency precondition, and the fallback for a backend that has not been
 * promoted yet.
 *
 * ON THE FALLBACK. The inspector deploys ahead of the backend, so for a window
 * `testSuites:applySuiteSettings` does not exist on the deployment this client
 * is talking to. Detected once per session by catching Convex's
 * "Could not find public function" and remembered, because retrying a missing
 * function on every save would put an error in the console for each one. The
 * fallback is the mutation the sheet used before — same arguments, minus the
 * revision fields — so the sheet WORKS on both, just without history on the
 * old one. Removing it is a follow-up once prod lists the composite.
 */

import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  type SuiteSettingsDraft,
  type SuiteSettingsKey,
  toUpdateArgs,
} from "./suite-settings-draft";

/** The code the backend raises when someone else saved first. */
export const EVAL_SUITE_REVISION_CONFLICT = "EVAL_SUITE_REVISION_CONFLICT";

/**
 * Arguments the pre-composite `updateTestSuite` does not declare, and the
 * draft key each one carries.
 *
 * Convex validators are strict — one unrecognized key rejects the whole
 * mutation — so sending these to a backend that predates them turns a save of
 * five settings into an ArgumentValidationError that saves none of them.
 *
 * Argument name and draft key are both spelled out because they are not the
 * same namespace: `toUpdateArgs` already renames one on its way out
 * (`computerEnvironmentId` travels inside `environment`). The caller keeps the
 * DRAFT key dirty, so guessing it from the argument name would leave the wrong
 * field — or none — retryable.
 */
const LEGACY_UNSUPPORTED_ARGS: ReadonlyMap<string, SuiteSettingsKey> = new Map<
  string,
  SuiteSettingsKey
>([["judgeRubric", "judgeRubric"]]);

export type CommitOutcome =
  /**
   * `droppedKeys` names settings the save could NOT carry — a legacy
   * deployment whose mutation does not declare them. The caller must keep
   * those dirty: reporting a clean save for a field that never travelled is
   * how an edit disappears while its own toast says it was kept.
   */
  | {
      status: "saved";
      revisionNumber: number | null;
      droppedKeys: SuiteSettingsKey[];
    }
  | { status: "conflict"; current: number | null }
  | { status: "failed"; message: string };

function readConvexErrorCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown })?.data;
  if (data && typeof data === "object" && "code" in data) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Is this the error a deployment raises for a function it does not have?
 *
 * Matched on the message because Convex reports it as a plain error rather
 * than a coded one. Deliberately narrow: a broader match would swallow a real
 * failure and silently downgrade every save to the legacy path.
 */
function isMissingFunctionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Could not find public function/i.test(message);
}

export function useSuiteSettingsCommit() {
  const applySuiteSettings = useMutation(
    "testSuites:applySuiteSettings" as never,
  );
  const updateTestSuite = useMutation("testSuites:updateTestSuite" as never);
  const [isCommitting, setIsCommitting] = useState(false);
  // Session-scoped, not per-render: one probe, then every later save takes the
  // legacy path directly.
  const compositeMissing = useRef(false);

  const commit = useCallback(
    async (args: {
      draft: SuiteSettingsDraft;
      suiteId: string;
      note?: string;
      source?: "ui";
      expectedRevisionNumber?: number;
      liveEnvironment?: { servers?: unknown[]; serverBindings?: unknown };
    }): Promise<CommitOutcome> => {
      const updateArgs = toUpdateArgs(
        args.draft,
        args.suiteId,
        args.liveEnvironment,
      );
      setIsCommitting(true);
      try {
        if (!compositeMissing.current) {
          try {
            const result = (await applySuiteSettings({
              ...updateArgs,
              revision: {
                source: args.source ?? "ui",
                ...(args.note ? { note: args.note } : {}),
              },
              // Sent only when the client actually knows a revision number.
              // On a deployment without history there is nothing to be stale
              // against, and sending a guess would refuse every save.
              ...(args.expectedRevisionNumber !== undefined
                ? { expectedRevisionNumber: args.expectedRevisionNumber }
                : {}),
            } as never)) as { revisionNumber?: number | null } | null;
            const revisionNumber = result?.revisionNumber ?? null;
            toast.success(
              revisionNumber === null
                ? "Settings saved"
                : `Settings saved · r${revisionNumber}`,
            );
            return { status: "saved", revisionNumber, droppedKeys: [] };
          } catch (error) {
            if (readConvexErrorCode(error) === EVAL_SUITE_REVISION_CONFLICT) {
              const data = (error as { data?: { current?: number } }).data;
              return { status: "conflict", current: data?.current ?? null };
            }
            if (!isMissingFunctionError(error)) throw error;
            compositeMissing.current = true;
          }
        }

        // Legacy path: no revision, no precondition. The sheet still batches
        // the edits into ONE write, which is most of the value.
        //
        // Fields the OLD mutation does not declare are dropped rather than
        // sent. Convex validators are strict, so one unknown key rejects the
        // whole call — a draft that touched a judge rubric would fail to save
        // the name beside it, and the person would have no way to tell which
        // of their edits was the problem. Dropping is not silent: the toast
        // below names what did not travel, and the field is still in the draft
        // to save once the backend catches up.
        const legacyArgs: Record<string, unknown> = {};
        const dropped: SuiteSettingsKey[] = [];
        for (const [key, value] of Object.entries(updateArgs)) {
          const droppedKey = LEGACY_UNSUPPORTED_ARGS.get(key);
          if (droppedKey !== undefined) {
            dropped.push(droppedKey);
            continue;
          }
          legacyArgs[key] = value;
        }
        await updateTestSuite(legacyArgs as never);
        toast.success(
          dropped.length === 0
            ? "Settings saved"
            : `Settings saved, except ${dropped.join(" and ")} — this deployment does not support it yet`,
        );
        return { status: "saved", revisionNumber: null, droppedKeys: dropped };
      } catch (error) {
        const message = getBillingErrorMessage(
          error,
          "Failed to save settings",
        );
        toast.error(message);
        console.error("Failed to save suite settings:", error);
        return { status: "failed", message };
      } finally {
        setIsCommitting(false);
      }
    },
    [applySuiteSettings, updateTestSuite],
  );

  return { commit, isCommitting };
}

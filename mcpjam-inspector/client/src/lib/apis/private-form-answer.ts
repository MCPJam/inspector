import { waitForPluginOperation } from "@/shared/plugin-operation";
import { webPost } from "./web/base";

export type PrivateFormAnswerScope = {
  kind: "legacy" | "mrtr";
  id: string;
  round: number;
};

/** One owned request/round. Reuse the exact receipt after an uncertain submit. */
export function createPrivateFormAnswer(scope: PrivateFormAnswerScope) {
  const controller = new AbortController();
  let cached: { bytes: string; receipt: string } | undefined;
  let busy = false;
  return {
    /** `signal` ends this attempt's wait (a submit deadline), so a retry
     * is never refused as "already being submitted". */
    async prepare(value: unknown, signal?: AbortSignal): Promise<string> {
      controller.signal.throwIfAborted();
      if (busy) throw new Error("A form answer is already being submitted");
      const bytes = JSON.stringify(value);
      if (!bytes || new TextEncoder().encode(bytes).byteLength > 256 * 1024)
        throw new Error("The form answer is too large");
      if (cached?.bytes === bytes) return cached.receipt;
      busy = true;
      const attempt = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      try {
        const query = new URLSearchParams({
          kind: scope.kind,
          id: scope.id,
          round: String(scope.round),
        });
        const receipt = await waitForPluginOperation(attempt, () =>
          webPost<unknown, { ok: boolean; storageId: string }>(
            `/api/web/plugin-forms/answer-upload?${query}`,
            value,
            { signal: attempt },
          ),
        );
        attempt.throwIfAborted();
        if (
          receipt?.ok !== true ||
          typeof receipt.storageId !== "string" ||
          !receipt.storageId.trim() ||
          receipt.storageId.length > 512
        )
          throw new Error("Invalid private form storage receipt");
        cached = { bytes, receipt: receipt.storageId };
        return receipt.storageId;
      } finally {
        busy = false;
      }
    },
    dispose() {
      cached = undefined;
      controller.abort();
    },
  };
}

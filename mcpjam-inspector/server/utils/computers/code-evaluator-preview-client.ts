/**
 * Boots the box a draft code evaluator is tested in ("Test on a past
 * iteration", EFTW-90). Kept out of `control-plane-client.ts`, which has no
 * room left to grow.
 */
import {
  memberAndServiceHeaders,
  postJson,
  type ControlPlaneResult,
} from "./control-plane-client.js";

/**
 * `sandboxId`, `sandboxRowId`, `runId`, `network`, and `gradingFiles: { url,
 * bytes }` when the iteration kept an archive. Unchecked here: the caller
 * checks what it uses and releases a box it can't use (`evaluator-test.ts`).
 */
export type CodeEvaluatorPreviewReply = Record<string, unknown> | null;

/**
 * One attempt, so a capacity refusal reaches the person waiting with its
 * Retry-After. Refusals carry the backend's reviewed copy in `error`; a
 * network failure is logged once, by the route. Without `network`, the box
 * gets the suite's saved setting.
 */
export function provisionCodeEvaluatorPreview(args: {
  bearer: string;
  suiteId: string;
  iterationId: string;
  network?: "none" | "web";
  signal?: AbortSignal;
}): Promise<ControlPlaneResult<CodeEvaluatorPreviewReply>> {
  return postJson<CodeEvaluatorPreviewReply>(
    "/evals/code-evaluator-preview/provision",
    memberAndServiceHeaders(args.bearer),
    {
      suiteId: args.suiteId,
      iterationId: args.iterationId,
      ...(args.network ? { network: args.network } : {}),
    },
    args.signal,
    { quietNetworkErrors: true },
  );
}

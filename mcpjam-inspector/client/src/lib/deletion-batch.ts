import { deletionMessage } from "./deletion-message";

export type RunDeletion = (runId: string) => Promise<unknown>;

/** Stop when a durable job is accepted: the org permits one active object job. */
export async function deleteRunBatch(ids: string[], remove: RunDeletion) {
  const receipts: { id: string; result: unknown }[] = [];
  let refusal: unknown;
  let refused = false;
  for (const id of ids) {
    try {
      const result = await remove(id);
      receipts.push({ id, result });
      if (deletionMessage(result, "completed") === "Deletion started") break;
    } catch (error) {
      // The caller reports refusal and retains this and all unsubmitted IDs.
      refusal = error;
      refused = true;
      break;
    }
  }
  const remaining = ids.slice(receipts.length);
  const started = receipts.some(
    ({ result }) => deletionMessage(result, "completed") === "Deletion started",
  );
  const completed = receipts.length - Number(started);
  const progress = [
    completed ? `Deleted ${completed} run(s)` : "",
    started ? "Deletion started for 1 run" : "",
  ]
    .filter(Boolean)
    .join(". ");
  const message = remaining.length
    ? `${progress ? `${progress}. ` : ""}${remaining.length} run(s) ${refused ? "not confirmed. Retry explicitly." : "not submitted. Retry after deletion finishes."}`
    : progress;
  return { receipts, remaining, refused, refusal, message };
}

import { acquirePlaygroundHarnessBox } from "../../utils/harness/playground-box.js";
import type { TurnResources } from "./resources.js";

/**
 * Acquire the conversation's Playground box and hand its release to the turn
 * holding it. The turn may already have ended when the box arrives (it failed
 * while this call was in flight, which an early booking makes possible); the
 * box is then released at once instead of beating on.
 */
export async function acquireOwnedPlaygroundHarnessBox(
  resources: Pick<TurnResources, "own">,
  args: Parameters<typeof acquirePlaygroundHarnessBox>[0],
): ReturnType<typeof acquirePlaygroundHarnessBox> {
  const acquired = await acquirePlaygroundHarnessBox(args);
  if (!acquired.ok) return acquired;
  try {
    resources.own(() => acquired.box.release());
  } catch (error) {
    await acquired.box.release();
    throw error;
  }
  return acquired;
}

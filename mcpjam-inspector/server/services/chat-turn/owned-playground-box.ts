import {
  type PlaygroundBoxReason,
  acquirePlaygroundHarnessBox,
  playgroundHarnessBoxUnavailableReason,
} from "../../utils/harness/playground-box.js";
import { type EarlyStart, startEarly } from "../../utils/early-start.js";
import type { TurnResources } from "./resources.js";

type BoxArgs = Parameters<typeof acquirePlaygroundHarnessBox>[0];
type Acquired = Awaited<ReturnType<typeof acquirePlaygroundHarnessBox>>;

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

/**
 * Start booking the turn's Playground box now, while its secrets read is in
 * flight, when no check before the booking can refuse the turn: a member's
 * box for any reason but `credential` (which waits on the member's own key
 * check), on a server that can run boxes. Anything else books where the turn
 * reaches the box, and gets `undefined` here.
 */
export function startPlaygroundBoxEarly(
  resources: Pick<TurnResources, "own">,
  reason: PlaygroundBoxReason | null,
  args: Omit<BoxArgs, "chatSessionId"> & { chatSessionId: string | undefined },
  guest: boolean,
): EarlyStart<Acquired> | undefined {
  const { chatSessionId, harness } = args;
  if (!reason || reason === "credential" || guest || !chatSessionId || !harness)
    return undefined;
  if (playgroundHarnessBoxUnavailableReason(harness, reason)) return undefined;
  return startEarly(() =>
    acquireOwnedPlaygroundHarnessBox(resources, { ...args, chatSessionId }),
  );
}

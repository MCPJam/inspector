import { assertFollowupWindow } from "./evidence.mjs";

// A failed lane cannot release queued work while its old turn is retiring.
export function createMeasurementLane() {
  let tail = Promise.resolve(),
    failure;
  return async (run) => {
    const prior = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (failure) throw failure;
      return await run();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      release();
    }
  };
}

export async function measurePaths(paths, measure, recordFailure, window) {
  for (const path of paths) {
    try {
      await measure(path);
    } catch (error) {
      const sample = await recordFailure(path, error);
      if (
        !sample.drained ||
        sample.protocolFailure ||
        !Number.isFinite(sample.submittedAt)
      )
        return;
      try {
        assertFollowupWindow(sample.followupMs, window);
      } catch {
        // An invalid submission window cannot supply a matched comparison.
        return;
      }
    }
  }
}

/**
 * The states of a run-group launch, whatever it launches: the backend's
 * `runGroupLaunches` record, kept by the launch engine
 * (`server/services/run-group-launch/`). Swarms are the first kind; each kind
 * gives its record and items their own names in its public view.
 */

/** One item's progress through a launch. */
export type LaunchItemStatus =
  "pending" | "starting" | "started" | "failed" | "not_started";

/** Where a launch as a whole stands. */
export type LaunchState =
  "launching" | "launched" | "partial" | "stopped" | "interrupted" | "failed";

/** Why an item, or the whole launch, did not go ahead. */
export interface LaunchError {
  status?: number;
  code?: string;
  message: string;
}

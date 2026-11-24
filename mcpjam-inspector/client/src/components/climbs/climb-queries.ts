import { makeFunctionReference } from "convex/server";

/**
 * Reads the screens make straight from the backend, as the person: the runs
 * behind a climb's units, and a run. They are reads of data the person can
 * already open elsewhere; every write goes through an operation.
 */
export const runGroupsQuery = makeFunctionReference<"query">("climbs:getClimbRunGroups");
export const runQuery = makeFunctionReference<"query">("testSuites:getTestSuiteRun");

/** One run group a climb registered: the runs it launched, per environment. */
export type RunGroup = {
  unitKey: string;
  role: string;
  runGroupId: string;
  environmentIds: string[];
  launchedRunIds: string[];
};

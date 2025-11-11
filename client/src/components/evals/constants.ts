export const RUN_FILTER_ALL = "all";
export const RUN_FILTER_LEGACY = "legacy";

export type RunFilterValue =
  | typeof RUN_FILTER_ALL
  | typeof RUN_FILTER_LEGACY
  | string;



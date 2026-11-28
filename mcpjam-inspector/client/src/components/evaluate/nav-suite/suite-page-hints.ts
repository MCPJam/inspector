/** What the ⓘ beside the history strip's metric labels says. */
export const SUITE_METRIC_HINTS = {
  latency:
    "Time for one iteration, including all model turns and tool calls. P50 is the typical iteration; P95, the slowest 1 in 20.",
  tokens: "Tokens the model used per iteration, averaged over the run.",
  toolCalls:
    "Tool calls the model made in the run, added up across every iteration.",
};

/** What the ⓘ beside the runs table's column headers says. */
export const SUITE_COLUMN_HINTS = {
  Latency:
    "Median time for one iteration in this run, including all model turns and tool calls.",
  Tokens: "Tokens the model used in this run, added up across every iteration.",
  Calls:
    "Tool calls the model made in this run, added up across every iteration.",
};

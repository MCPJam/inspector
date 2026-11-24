# Reading a round

`get_climb_round` returns one verdict and the numbers behind it.

- **kept**: the measure moved the right way on steering cases in at least one environment, and in no environment did the measure or pass rate move the wrong way, on steering or validation cases. `validation` says whether validation cases also improved (`better`) or did not move (`unchanged`). A kept change that also helped on validation comes first in the prompt.
- **reverted**: something moved the wrong way, or the measure did not move the right way. `failedSteeringCaseKeys` names a steering case that failed. For validation it only says `validationRegressed: true`: that is all you get, on purpose.
- **not decided**: the two results could not be compared. The reasons: a run is missing (`run_missing`), more than one in ten iterations were lost (`too_many_lost`, the environment is named), the real server changed since the best was measured (`real_server_changed`), or the measure was not recorded (`measure_not_comparable`).

Every move is judged against the noise between the two baseline runs. A pass rate move counts when it is larger than the noise and more than one iteration. A tokens, cost or tool-calls move counts when it is larger than the noise and at least the smallest improvement (1% unless set). Ratios below 1 are the right way; they compare totals on the cases both servers passed, passing iterations only.

When the best so far's numbers are older than an hour, or the suite or an environment changed, the round measures the best again beside the candidate and says why (`remeasureBest`). That is a second run group, and the estimate counts it.

What to do next: a reverted round says what moved the wrong way; try a smaller change to the same place or a different place. A kept round becomes the best so far; the next mock change builds on its mock. A kept code round makes its saved server the best so far: leave its code as it is, and run the next code change on another saved server.

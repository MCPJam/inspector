---
"@mcpjam/inspector": patch
---

The user-value chain is visible on `/evals` run detail when it has data

The chain funnel was mounted on run detail but could not be seen on the runs where it was the only thing to show. Two gates decide whether the insight rail exists at all — `run-insight-rail.tsx`'s emptiness check and `run-detail-view.tsx`'s `hasInsightContent` — and both counted only the triage, goal-completion and groundedness cards. A run with a derived chain and no judge or triage output rendered no rail, so the funnel it contained was never drawn.

Adding the chain card to those checks would have traded one bug for another, which is why the exclusion was deliberate and documented: the card is a truthy fragment whose two halves each suppress themselves from the inside, so counting the NODE would keep an otherwise-empty rail alive as a full-height column of dead space on every run with no insight content at all.

So the gates now read a fact about the DATA instead. A probe mounted above every layout branch asks the same rollup query the funnel itself uses — `undefined` while loading, `null` for a run with no rollup, which is exactly the panel's own render condition — and reports one boolean that both gates consume. Convex de-duplicates identical subscriptions, so asking twice costs one query, and the probe carries the same `ErrorBoundary` the panels do: `useQuery` throws when the query is not deployed or when there is no `ConvexProvider`, and a probe that took the page down with it would be worse than the empty rail it exists to prevent. Undeployed reads as "no funnel", which is correct.

The state starts `false`, so a run without a funnel never flashes an empty rail on the way to finding out.

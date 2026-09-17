---
"@mcpjam/inspector": patch
---

The Run tab sits last on a swarm run page, after Findings, Insights and Sessions.

It had led the strip since the live matrix moved onto the run URL, so opening a finished wave put the watch surface first on a page that is almost always read after the fact. Findings is what a reader wants from a settled run, and it leads again.

Nothing about landing changes. A live wave with no explicit tab still opens Run, through the same resolver as before; `?tab=` still wins; a `?session=` deep-link still opens Sessions. The order is presentation only.

`DETAIL_TAB_OPTIONS` moves into `swarm-run-detail-model.ts` alongside the tab resolver it belongs with, so the order is covered by that module's tests rather than living inline in the page.

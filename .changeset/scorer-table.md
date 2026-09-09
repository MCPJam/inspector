---
"@mcpjam/inspector": patch
---

Scorers settings is a chain-ordered table with Gate/Warn/Report roles

The Grading tab listed matchers, checks, and the judge as three unrelated
blocks, so a reader could finish the page and still not know which links of
the request-delivery path the suite actually grades. Those same fields now
sit in one table in user-value-chain order. A check can be a gate, a warn,
or a report — the same policy the runner already honours — without inventing
a parallel `scorerRoles` setting. Last-run and trend columns stay out: this
page is configuration, and those numbers would be a later slice that needs
run data this sheet does not have. On a deployment that has not shipped
check-policy capabilities, Role stays the read-only Gate chip it is today.

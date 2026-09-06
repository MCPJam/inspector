---
"@mcpjam/inspector": patch
---

The evaluate run page can show which tool routes a case took

**A failing case that only said pass/fail.** The matcher already knew which expected tools were missing and which extras showed up, but the redesigned run page still asked the reader to open every iteration. Behind `evaluate-route-facts-enabled` a case row now carries a one-line route summary and two collapsed expanders — Routes, and Expected vs observed — computed from the iterations the page already has. Substitution is named only for the one-to-one in-catalog shape. Flag off is no computation and no DOM.

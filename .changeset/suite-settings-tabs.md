---
"@mcpjam/inspector": patch
---

Suite settings now open at `…/suite/<id>/settings`, and the breadcrumb reads "Suite settings". Old `…/edit` links redirect there. Behind the `eval-suite-settings-tabs` flag, the page splits into Settings and Default evaluators tabs and asks before a tab switch drops unsaved changes.

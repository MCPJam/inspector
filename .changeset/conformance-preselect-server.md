---
"@mcpjam/inspector": patch
---

Conformance: the server picker now lists every server in the project, not only connected ones, and also sits beside the Run button before the first run. Running on a server that is not connected connects it first. If that fails, the page names the server and offers Retry or Edit connection instead of a toast. A project with no servers shows "Add a server to run conformance checks" with an Add server button that opens the form on this page.

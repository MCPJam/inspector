---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
---

Local eval reports in HTML and JUnit now show each iteration's tool calls with their arguments, tokens, scorer results and duration for every case, including cases that passed. Before, they showed only each case's verdict. HTML lists this under "Iteration evidence", one collapsed section per case below the summary. JUnit puts it in each test case's `<system-out>`. Long values are cut with a note: tool arguments after 2,000 characters in HTML and 500 in JUnit, scorer reasons and errors after 1,000, and tool calls after 25 per iteration. The JSON report and the terminal summary are unchanged. This applies to `mcpjam test --reporter html|junit-xml` and to `renderStructuredRunHtml` / `renderStructuredRunJUnitXml` for an `eval-local-run` report.

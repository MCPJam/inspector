---
"@mcpjam/inspector": patch
---

Inspector updates:

- Add PostHog instrumentation to Evaluate covering the activation funnel and run lifecycle: `evaluate_tab_viewed`, `suite_viewed`, `eval_suite_run_completed` (with pass/fail counts and duration), `eval_generate_tests_completed` (with success flag and count), `eval_run_insights_opened`, `eval_suite_server_changed`, `eval_test_case_deleted`, and `eval_test_case_edited`

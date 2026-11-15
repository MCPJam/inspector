---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Mid-session sign-in fixes from release QA:

- Resources and Prompts no longer show the raw 401 error under the Connect card.
- When the selected client ignores a 401 sign-in request (for example, a custom client set to pass it through), Tools, Resources and Prompts now show the call as failed, with the server's reason. Before, the call showed only a note.
- After the sign-in redirect reloads the page, a Compare pane shows "Loading saved configuration…" until the models load, instead of briefly saying its saved model is unavailable.
- The Claude readiness finding for a 401 without a `WWW-Authenticate` header no longer adds a note about `isError` results. That note now appears only when the server answered with a 200 `isError` result.

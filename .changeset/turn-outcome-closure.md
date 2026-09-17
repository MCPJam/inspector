---
"@mcpjam/inspector": patch
---

Close a partial turn's open tool calls instead of leaving them eligible for execution. A turn that ends abnormally can leave a tool call with no result, and the next turn's loop treated every unresolved historical call as work to do — so a call the user pressed Stop on would execute for real afterwards.

The shared helper writes one synthetic result per open call, in one of two states: a call that never started says so, and a call that was already sent says its outcome is unknown and it may have taken effect. The result is spliced directly after its assistant message, because providers reject a request whose tool call is not answered by the next one.

Three places apply it and all three produce the same bytes: the client on Stop, so the user can send again immediately; the server at persist time; and a new ingress guard that runs an inherited call only when something names it as a resume — an approval pause, an MRTR or scope step-up resume, or a client-fulfilled call the browser owns.

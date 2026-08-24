---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Let agents see and drive MCP App widgets, not just read their HTML.

A tool that returns a `ui://` resource is two products in one: the tool result a
model reads, and the interface a person sees. Every machine surface could
inspect the first half. Nothing could inspect the second — an agent debugging
its own MCP App could fetch the widget's HTML and had no way to learn whether it
actually rendered, what it showed, or which tools it fired.

**Widgets as text.** The browser harness gains `captureSnapshot()`: the widget's
accessibility tree plus its interactive elements, returned in the *same*
role/name/testId vocabulary the interaction steps already accept, so a caller
reads a control and addresses it directly. This is what makes the surface usable
by a text-only model at all — every existing way to drive a widget was
coordinate-based (`[x, y]`), which silently assumed the caller could see pixels.
A model handed a screenshot and no handles has nothing to click.

**Locally** (`/api/mcp/widget-session`), two new endpoints pair with it:
`GET /:id/snapshot` reads the widget without consuming its interaction budget —
looking is not acting, and a caller forced to spend steps on looking would
interact blind to save them — and `POST /:id/scripted-step` drives it by
role/name/testId instead of by coordinate. `POST /api/mcp/widget-render` gains
`includeSnapshot`.

**Hosted**, `POST /v1/projects/{p}/servers/{s}/widgets/render`
(`render_server_widget`) calls the tool, mounts its widget in real headless
Chromium running the production host bridge, and returns the render verdict, the
console errors, the blocked requests, and the tree. Stateless by construction —
connect, call, render, read, dispose in one request — which is what makes it
safe on a plane with no session affinity; interactive sessions stay local
because they hold a live browser in process.

Its payload defaults are the reverse of the local route's, deliberately: the
snapshot is on and the screenshot is off, because this endpoint's caller is
usually a model, for which a base64 image it may not even be able to see is the
most expensive possible way to say nothing.

The op executes the caller's tool, so it inherits `call_server_tool`'s gating: a
human approves it, with the arguments previewed. It annotates as destructive and
explicitly **not** idempotent — nobody can promise that running a third party's
tool twice is safe.

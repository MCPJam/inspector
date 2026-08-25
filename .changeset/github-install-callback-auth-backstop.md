---
"@mcpjam/inspector": patch
---

The GitHub install callback stops spinning forever when auth never becomes usable.

Waiting for authentication before firing the bind is correct and already shipped — but the wait had no floor. A WorkOS session that resolves a user and then never becomes *usable* (a token Convex rejects, a refresh that fails, a user row that never provisions) leaves the signed-out branch unfired and the gating effect returning on every pass, so `Finishing up with GitHub…` stays on screen indefinitely. This page has no other content to fall back to and nothing to click.

A twelve-second backstop now converts that into a stated outcome. It is deliberately a **timer, not a "settled and still not usable" test**: WorkOS resolving a user and Convex flipping `isAuthenticated` are separate ticks, so there is a legitimate instant in which a member is indistinguishable from a permanent failure, and a false refusal there would break the happy path for everyone to fix a slow path for a few. A timer also covers causes this page cannot enumerate. Twelve seconds is past a cold Convex handshake and short of a person deciding the page is broken.

The message is its own string rather than the signed-out one, because the instruction differs: the person *is* signed in, so telling them to sign in reads as wrong. It names MCPJam as the side that could not confirm and says explicitly that nothing is wrong with their GitHub account — otherwise the natural next move is to go audit GitHub settings that are already fine. A specific refusal that lands before the timer fires still wins; the backstop only overwrites the neutral working state.

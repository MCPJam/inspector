---
"@mcpjam/inspector": patch
---

Fix a client permalink for a deleted client hanging the app.

Client URLs are permalinks, so a bookmark or history entry for `/hosts/:hostId` outlives the client itself. Opening one after the client was deleted — or opening a teammate's link while signed into a different project — put `HostsRoute` and `HostsTab` in a fight over the same id. The route synced the id out of the URL into shared state and into the project's persisted "previewed client"; `HostsTab` reconciled both against the loaded client list, found the id missing, and cleared them; the route then synced the id straight back from the URL, and around again.

The corrective `navigate('/hosts')` never landed. It is a React Router transition, so the stream of higher-priority state updates from that ping-pong starved it indefinitely. The usual symptom was silent: the page looked normal while the tab pegged a CPU core (a harness reproduction rendered over 17,000 times in two seconds). When the updates happened to chain synchronously it instead tripped React's nested-update limit and the app fell through to the route error screen with "Maximum update depth exceeded" — the shape reported by a self-hosted user in Sentry.

`HostsRoute` now resolves the URL id against the client list before it syncs or persists anything, and treats an id the list doesn't contain as unopenable. Nothing writes the dead id back, so there is nothing for `HostsTab` to fight, and the route bounces once to the client list at `/hosts` with a toast explaining the client no longer exists. The bounce uses `replace`, so the dead URL leaves the history stack instead of sitting one Back press away.

The check waits for the client list to finish loading before calling any id dead — the list is empty for a beat on every cold start, and bouncing during that window would break working deep links.

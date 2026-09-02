---
"@mcpjam/inspector": patch
---

Connecting a GitHub account fills the repository picker, without a reload

Finishing an installation claim in Settings → Integrations → GitHub left the page saying **"No repositories available. Connect a GitHub account above first."** The bind had succeeded: the backend was already answering with every repository the App could reach. Only a manual reload showed them. Looking at that list is the first thing anyone does after connecting an account, and it was telling them their bind had not worked.

**The listing is a one-shot read of a live fact.** Repositories come from an action, which nothing re-runs on its own; which installations the organization holds comes from a query, which updates itself. The effect that fetched the listing depended on the organization, on availability, and on two memoized callbacks — and completing a bind changes none of them, so it never ran again.

It now also depends on the bindings, through a **stable key** rather than the array: a Convex subscription hands back a fresh array on every delivery, including one re-sending identical rows, so depending on the array itself would ask GitHub again on every poll. The key is each binding's opaque installation reference and its status, sorted. That is exactly what changes which repositories the App can reach — an account connected, one disconnected, or one that GitHub suspended or removed — and nothing else: row order, account logins and timestamps do not move it.

Three things the surface already guaranteed still hold, and one is now stated more precisely:

- **A slow answer for the previous organization still cannot land on the new one.** The in-flight guard became a generation rather than a per-run flag, because the two rules differ: a re-run that merely learns the bindings' first answer must leave a request in flight alone, while one that supersedes it must guarantee that answer can never arrive.
- **The picker still resets when the organization changes** — the connect sends the current organization id, so a selection carried across would be submitted against an organization the repository does not belong to. It deliberately does **not** reset when a binding changes: the organization has not changed, and a repository that disappeared from the refreshed listing cannot be submitted anyway.
- **The bindings query answering for the first time is not a change.** It is not subscribed until availability says `enabled`, so it always answers after the first listing was requested — treating that as news would ask GitHub twice on every page load.

The suite page's own connect section had the same staleness. No bind starts there, so the reported sequence cannot happen on it, but a binding changing elsewhere — another admin, a second tab, a webhook suspending an installation — left it just as stale. It follows the same key now.

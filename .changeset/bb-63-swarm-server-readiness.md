---
"@mcpjam/inspector": patch
---

"No servers to run against" stops telling you to connect a server you already have

Opening Swarms → New with a server in your project but none attached to the setup produced an amber warning whose remedy was "Connect a server and turn on Auto-connect on the Servers tab" — an instruction to redo work already done, next to a picker plainly listing the server you had. That is the whole of BB-63's "what did I do wrong?".

The readiness check now separates the three situations that shared one sentence, because each has a different fix:

- **Your project has a usable server, it just isn't in this setup.** The common case, and the one the old copy got wrong. The notice now names the server — "Your project has draw. Pick what this run should use." — which is both the next step and the evidence that nothing you did was wrong. Past two servers it names two and counts the rest rather than growing into a paragraph.
- **Your project is empty.** The only case where "connect a server" was ever the right instruction, and it keeps it.
- **Your servers exist but none is reachable from a cloud run.** Previously indistinguishable from the empty case, so the advice was to connect yet another server that would fail the same way. It now points at the same reachability remedy `local_only` gives.

`attachable` deliberately excludes stdio and localhost servers: offering one would have walked the user into the `local_only` failure on the very next click.

Alongside that, a new server group no longer opens as a form whose only answer was never in doubt. In a project with three or fewer servers the group arrives with them already ticked and Create already live, and the name is derived from the contents — `draw`, or `draw + 2` — instead of `group 1`. BB-3 reported a `group 1` holding a server called `rabona`; groups still cannot be renamed, so a name that starts out meaning something is worth more here than usual.

The launch gate itself is unchanged. A setup that would resolve to zero servers is still blocked before it writes personas and goals — that block exists because of a real `ENV_NO_SERVERS` failure (BB-36) and removing it would only move the failure later.

The band itself is calmer, too. "Less warning coded" is not only a copy problem: a calm sentence inside an amber box with an alert triangle still reads as an alarm. The notice now takes a tone, decided next to the copy rather than in the component that paints it, and the line it draws is which situation this is — nothing attached yet is a step in setup and renders quietly; servers that ARE attached and still cannot run keep the amber, because that one really is a problem to act on. `warning` stays the default, so the two callers that already had one — the swarm sandbox block and the evals suite pin — are untouched.

And the hint under the disabled Continue says what is missing instead of ordering a repair: "Pick a server to continue." rather than "Fix where it runs to continue." Nothing was broken; a required field simply has not been filled in.

An empty project also gets the one button that resolves it. "Connect a server and it shows up here" named an action the user could not take from where they were standing, and for a project with nothing in it that navigation is unavoidable — there is nothing on the screen to pick. The block now carries a Connect a server button, and the sentence drops the imperative so the prose explains while the button acts. Only the empty case gets one: a project that already has servers is fixed by choosing one right here, and sending that user to Connect would be the original misdiagnosis wearing a button. The draft survives the trip — the flow already mirrors name, description and targets into session storage on every change.

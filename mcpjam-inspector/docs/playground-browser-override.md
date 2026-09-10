# Temporary Playground Browser selection

Ordinary Playground chats already resolve execution settings with per-request
precedence over the selected client's defaults. Browser was an exception in the
UI: PlaygroundMain, the workspace panel and the fallback rail read the saved
`builtInToolIds` directly. The transport also omitted `[]`, accidentally turning
an explicit empty selection back into inheritance.

The Browser selector above Playground offers Client default, On for this
Playground, and Off for this Playground. It changes only Browser in the effective
built-in list, preserves other tools, and sends an explicit empty list when
needed. The workspace and fallback rail share the same ephemeral selection as
chat. There are no host-config mutations or local-storage writes. Selection
resets on leaving/reloading Playground or changing project, client or environment
mode. New chats in the same Playground retain the selection.

Enabling Browser makes its panel available; the user still chooses location and
grants Browser permission in that panel. Permission alone never opts an agent in.
Disabling the tool does not revoke device permission or terminate a browser the
user is viewing. Existing location stickiness, admission, consent, profile and
runtime checks remain in force.

Environment mode displays that Browser is controlled by the environment's
client and offers no override. Both environments and shared scenarios discard
request-body built-in overrides before execution resolution, including when the
saved client omits the field. Other supported Playground execution overrides
remain unchanged. The local route already rejects environment execution targets.

## Validation

Regression coverage checks temporary enable/disable without mutating defaults,
reset on scope change, preservation of other built-ins, explicit empty-list
transport, and server refusal to widen or narrow environment built-ins.

Manual smoke: use a client with Browser off, choose On for this Playground,
open the Browser panel and grant permission, then navigate through chat. Confirm
the saved client remains off. Choose Off and send another turn: Browser must no
longer be advertised. Reset to Client default, switch clients, and reload; verify
the default is restored. Repeat in both Browser layouts. Select an environment
and verify there is no temporary selector.

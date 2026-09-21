/**
 * The one place a tool's approval requirement is computed.
 *
 * Every tool a turn advertises carries a `needsApproval` declaration, and this
 * module is where the value comes from. There is exactly one input besides the
 * tool's own nature: the host's `requireToolApproval` switch.
 *
 * THE SWITCH DECIDES, for every tool the model calls to ACT. One setting, one
 * answer, and a user who turns it off sees no approval pill — on an MCP
 * server's tool, on a page's `webmcp_*` tool, on a browser verb, on a shell.
 *
 * It used to raise only. Several families sat at `always` and ignored it, so
 * "Tool Approval: off" still paused on the most common thing anyone does with
 * this product — open a page and click something. A switch that does not
 * govern the tools a person actually watches is not a switch, and the rule
 * "off means off" is worth more than a per-family judgement they cannot see.
 *
 * What is left at `never` is not a carve-out from that rule so much as the
 * absence of anything to decide: looking at something, listing your own
 * projects, the discovery meta-tools. Pausing an observation buys no safety
 * and costs a click, and it is what the setting's own copy promises.
 *
 * `always` survives for a family that must ask whatever the switch says.
 * Nothing sits there today as a FLOOR; the one thing that still asks
 * unconditionally declares it as a function, because the answer depends on
 * which value the model named — a third party's instructions entering the turn
 * (`computers/effective-skill-tools.ts`), which is a trust boundary rather
 * than a preference.
 *
 * WHY A FLOOR RATHER THAN A BOOLEAN AT EACH BUILDER. Before this, each builder
 * wrote its own expression — `isLocal ? true : opts.requireToolApproval ===
 * true`, `APPROVAL_REQUIRED_IDS.has(id) && flag`, `delivery.kind ===
 * "attested" || engine === "local"` — and each was individually right and
 * collectively unreadable. Naming the three answers makes the policy for a
 * whole turn something you can read off the builders, and makes a future
 * setting a change to THIS function's inputs rather than to any engine.
 */

/**
 * What a tool family needs from the user, before the switch is consulted.
 *
 *  - `never`   — asking buys nothing. Reads, observations, discovery.
 *  - `setting` — every tool that acts: the user's switch decides.
 *  - `always`  — asks whatever the switch says. See the header: no family
 *                declares this as a floor today, and one that wants it should
 *                have to argue why the user's own switch does not apply.
 */
export type ApprovalFloor = "never" | "setting" | "always";

/**
 * The declaration for one tool.
 *
 * `requireToolApproval` is typed as `boolean` and callers must coerce: several
 * call sites thread an optional flag, and `undefined` reaching a `&&` is how a
 * real tool once came to declare `undefined` instead of `false`.
 */
export function needsApprovalFor(
  floor: ApprovalFloor,
  requireToolApproval: boolean,
): boolean {
  switch (floor) {
    case "never":
      return false;
    case "always":
      return true;
    case "setting":
      return requireToolApproval === true;
  }
}

/**
 * The one place a tool's approval requirement is computed.
 *
 * Every tool a turn advertises carries a `needsApproval` declaration, and this
 * module is where the value comes from. There is exactly one input besides the
 * tool's own nature: the host's `requireToolApproval` switch.
 *
 * THE SWITCH RAISES. It can never lower. That is the whole semantics, and it
 * is what makes the two facts a user needs to hold in their head small enough
 * to hold: some actions always ask, and the switch makes everything else ask
 * too. A family that must ask (a shell on your own machine, a click on a live
 * signed-in page, a third party's instructions entering the turn) asks whether
 * the switch is on or off. A family that never needs to (looking at something,
 * listing your own projects, the discovery meta-tools) never asks, because
 * pausing an observation buys no safety and costs a click.
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
 *  - `setting` — the ordinary case: the user's switch decides.
 *  - `always`  — asks whatever the switch says. Reserved for actions whose
 *                blast radius is outside anything the turn can undo.
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

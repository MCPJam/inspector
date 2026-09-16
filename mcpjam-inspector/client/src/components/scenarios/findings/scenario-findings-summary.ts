/**
 * The Findings summary card's sentences for User Testing.
 *
 * Returned separately and joined into one paragraph by the card, same as the
 * swarm composer.
 *
 * The swarm composer answers "which goal broke, for which authored persona, at
 * which stage". This surface cannot answer the stage half yet, and its personas
 * ARE feelings, so it answers the question Vig framed instead: how did their
 * users feel, and what did that to them.
 *
 * Templates only. Nothing here may claim more than the counts support, and a
 * finished study never opens on an empty card.
 */

import type { PersonaFindingsModel } from "@/components/swarms/findings/findings-derivation";
import type { ScenarioFindingsModel } from "./scenario-findings-derivation";

/**
 * How a persona's sessions ENDED, as the lead sentence says it. Keyed on the pill
 * label this module's derivation sets, so the two stay in step.
 *
 * `gave_up` gets a clause rather than an adjective: the backend only admits it
 * when the user said so in words, and "ended gave up" would both read wrong and
 * lose that it was stated rather than inferred from a session going quiet.
 */
const ENDING_PHRASE: Record<string, string> = {
  "Gave up": "with the user saying they gave up",
  Frustrated: "frustrated",
  Neutral: "neutral",
  Satisfied: "satisfied",
  Uncategorized: "with too little to read",
};

function endingPhrase(persona: PersonaFindingsModel): string {
  return ENDING_PHRASE[persona.sentiment.label] ?? "unread";
}

/** The lead persona's worst goal, as a sentence about the experience. */
function causeLine(persona: PersonaFindingsModel): string | null {
  const stalled = persona.goals.find((g) => g.sentiment.label === "Stalled");
  if (stalled) return `"${stalled.title}" did not resolve for them.`;
  const uneasy = persona.goals.find((g) => g.sentiment.label === "Uneasy");
  if (uneasy) return `"${uneasy.title}" only partly resolved for them.`;
  if (persona.goals.some((g) => g.sentiment.label === "Landed")) {
    return "Every measured goal completed for them.";
  }
  // Goals exist but nothing was graded, or clustering placed none of their
  // sessions. Either way there is no goal to name, and inventing one would be
  // worse than the silence.
  return null;
}

export function composeScenarioFindingsSummary(
  model: ScenarioFindingsModel,
): string[] {
  const lead = model.personas[0];
  if (!lead) {
    // A study with sessions that have not been analyzed is not an empty study,
    // and must not read like one.
    if (model.unanalyzedCount > 0) {
      return [
        `No session has been analyzed yet, of ${model.unanalyzedCount}.`,
        "Nothing here is evidence about the experience.",
      ];
    }
    return ["No sessions in this study yet."];
  }

  // Both halves of the fraction have to come from the SAME population.
  // `sessionsAuthored` is tallied from the scanned page, which the tab caps, so
  // pairing it with the study total reads "12 of 900" where the 12 was counted
  // out of 200. The footnote about the cap sits nearby but a footnote cannot
  // repair a fraction — by the time it is read the number has been believed.
  const denominator = model.coverage.truncated
    ? model.coverage.scanned
    : model.sessionCount;
  const lines: string[] = [
    `${lead.sessionsAuthored} of ${denominator} sessions ended ${endingPhrase(
      lead,
    )}.`,
  ];

  const cause = causeLine(lead);
  if (cause) lines.push(cause);

  const second = model.personas[1];
  if (second) {
    lines.push(
      `${second.name} account for another ${second.sessionsAuthored}.`,
    );
  }

  return lines;
}

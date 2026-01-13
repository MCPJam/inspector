import {
  Bracket,
  GroupId,
  KnockoutSlot,
  KnockoutSlotSource,
  ResolvedBracket,
  TeamId,
  WorldCupPrediction,
} from "@shared/types";

/**
 * Get which group a team belongs to (from group predictions)
 */
const getTeamGroup = (teamId: TeamId, prediction: WorldCupPrediction): GroupId | undefined => {
  for (const group of prediction.groups) {
    for (const pos of [1, 2, 3, 4] as const) {
      if (group.positions[pos] === teamId) {
        return group.groupId;
      }
    }
  }
  return undefined;
};

/**
 * Constraint-satisfying third-place assignment using backtracking with MRV.
 * Assigns exactly 8 teams to 8 slots such that each team's group letter
 * is contained in the slot's allowed group letters.
 */
type QualifiedThird = { id: TeamId; groupLetter: GroupId };
type Slot = { slotId: string; label: string; letters: string };

/**
 * Get candidates for a slot (teams that can be assigned to it)
 */
const getCandidates = (
  slot: Slot,
  qualifiedThirds: QualifiedThird[],
  usedTeams: Set<TeamId>
): QualifiedThird[] => {
  return qualifiedThirds.filter(
    (team) => !usedTeams.has(team.id) && slot.letters.includes(team.groupLetter)
  );
};

/**
 * Find the slot with minimum remaining values (fewest candidates)
 */
const selectSlotMRV = (
  remainingSlots: Slot[],
  qualifiedThirds: QualifiedThird[],
  usedTeams: Set<TeamId>
): Slot | null => {
  if (remainingSlots.length === 0) return null;

  let minSlot = remainingSlots[0];
  let minCount = getCandidates(minSlot, qualifiedThirds, usedTeams).length;

  for (let i = 1; i < remainingSlots.length; i++) {
    const count = getCandidates(remainingSlots[i], qualifiedThirds, usedTeams).length;
    if (count < minCount) {
      minSlot = remainingSlots[i];
      minCount = count;
    }
  }

  return minSlot;
};

/**
 * Backtracking solver with MRV heuristic
 */
const assignThirdPlacesBacktracking = (
  qualifiedThirds: QualifiedThird[],
  slots: Slot[]
): Map<string, TeamId> => {
  const assignments = new Map<string, TeamId>();
  const usedTeams = new Set<TeamId>();

  const backtrack = (remainingSlots: Slot[]): boolean => {
    if (remainingSlots.length === 0) {
      return true; // All slots assigned
    }

    // MRV: select slot with fewest candidates
    const slot = selectSlotMRV(remainingSlots, qualifiedThirds, usedTeams);
    if (!slot) return false;

    const candidates = getCandidates(slot, qualifiedThirds, usedTeams);
    
    // Try candidates in ranked order (best→worst) for deterministic output
    for (const team of candidates) {
      // Try this assignment
      assignments.set(slot.slotId, team.id);
      usedTeams.add(team.id);

      // Recurse with remaining slots
      const remaining = remainingSlots.filter((s) => s.slotId !== slot.slotId);
      if (backtrack(remaining)) {
        return true;
      }

      // Backtrack
      assignments.delete(slot.slotId);
      usedTeams.delete(team.id);
    }

    return false; // No valid assignment found
  };

  if (!backtrack([...slots])) {
    // Build detailed debug info
    const remainingTeams = qualifiedThirds.filter((t) => !usedTeams.has(t.id));
    const remainingSlots = slots.filter((s) => !assignments.has(s.slotId));
    const candidatesPerSlot = remainingSlots.map((slot) => {
      const candidates = getCandidates(slot, qualifiedThirds, usedTeams);
      return `  ${slot.label}(${slot.letters}): ${candidates.length} candidates [${candidates.map((t) => `${t.id}(${t.groupLetter})`).join(", ")}]`;
    });

    throw new Error(
      `Cannot assign third-place teams to slots: unsatisfiable constraints.\n` +
      `Qualified teams (${qualifiedThirds.length}): ${qualifiedThirds.map((t) => `${t.id}(${t.groupLetter})`).join(", ")}\n` +
      `Remaining teams: ${remainingTeams.map((t) => `${t.id}(${t.groupLetter})`).join(", ")}\n` +
      `Remaining slots: ${remainingSlots.map((s) => s.label).join(", ")}\n` +
      `Candidates per slot:\n${candidatesPerSlot.join("\n")}`
    );
  }

  return assignments;
};

const assignThirdPlaceTeams = (
  prediction: WorldCupPrediction,
  template: Bracket
): Map<string, TeamId> => {
  // Get all 12 third-place teams with their groups
  const thirdPlaceTeams: Array<{ teamId: TeamId; groupId: GroupId }> = [];
  for (const group of prediction.groups) {
    const teamId = group.positions[3];
    if (teamId) {
      thirdPlaceTeams.push({ teamId, groupId: group.groupId });
    }
  }

  // Get exactly 8 qualified teams (by order in advancingThirdPlaceTeamIds)
  // Array order maintains rank (best→worst) for deterministic output
  const qualifiedThirds: QualifiedThird[] = [];
  for (let i = 0; i < prediction.thirdPlaceSelection.advancingThirdPlaceTeamIds.length && qualifiedThirds.length < 8; i++) {
    const teamId = prediction.thirdPlaceSelection.advancingThirdPlaceTeamIds[i];
    const team = thirdPlaceTeams.find((t) => t.teamId === teamId);
    if (team) {
      qualifiedThirds.push({ id: teamId, groupLetter: team.groupId });
    } else {
      // Try to find group from all positions
      const groupId = getTeamGroup(teamId, prediction);
      if (groupId) {
        qualifiedThirds.push({ id: teamId, groupLetter: groupId });
      }
    }
  }

  // If not exactly 8 teams, return empty assignments (partial selection or initial state)
  // The UI will show TBD until all 8 teams are selected
  if (qualifiedThirds.length !== 8) {
    return new Map<string, TeamId>();
  }

  // Define slots with their constraints
  const slots: Slot[] = [
    { slotId: "R32-M3-A", label: "3ABCDF", letters: "ABCDF" },
    { slotId: "R32-M6-A", label: "3CDFGH", letters: "CDFGH" },
    { slotId: "R32-M7-A", label: "3CEFHI", letters: "CEFHI" },
    { slotId: "R32-M10-A", label: "3BEFIJ", letters: "BEFIJ" },
    { slotId: "R32-M9-A", label: "3AEHIJ", letters: "AEHIJ" },
    { slotId: "R32-M13-A", label: "3EFGIJ", letters: "EFGIJ" },
    { slotId: "R32-M8-A", label: "3EHIJK", letters: "EHIJK" },
    { slotId: "R32-M16-A", label: "3DEIJL", letters: "DEIJL" },
  ];

  return assignThirdPlacesBacktracking(qualifiedThirds, slots);
};

const resolveSource = (
  source: KnockoutSlotSource,
  prediction: WorldCupPrediction,
  template: Bracket,
  thirdPlaceAssignments?: Map<string, TeamId>,
  slotId?: string
): string | undefined => {
  switch (source.type) {
    case "group-position": {
      const group = prediction.groups.find((g) => g.groupId === source.groupId);
      const teamId = group?.positions[source.position];
      // If position is not filled, return empty string instead of undefined to prevent TBD
      // (This shouldn't happen if user filled all positions, but prevents TBD)
      return teamId || "";
    }
    case "third-ranked": {
      if (!thirdPlaceAssignments || !slotId) {
        // If assignments not provided, return undefined (will show as TBD)
        return undefined;
      }
      const assigned = thirdPlaceAssignments.get(slotId);
      // If no assignment found (e.g., teams not yet selected), return undefined
      // This allows the UI to show TBD until third-place teams are selected
      return assigned;
    }
    case "winner-of-match":
      return prediction.knockout.winnersByMatchId[source.matchId];
    default:
      return undefined;
  }
};

const resolveSlotTeamId = (
  slot: KnockoutSlot,
  prediction: WorldCupPrediction,
  template: Bracket,
  thirdPlaceAssignments?: Map<string, TeamId>
): string | undefined => {
  const source = slot.source;
  if (!source) return undefined;

  return resolveSource(source, prediction, template, thirdPlaceAssignments, slot.id);
};

export const resolveBracketLocally = (
  template: Bracket,
  prediction: WorldCupPrediction
): ResolvedBracket => {
  // Compute third-place assignments using FIFA algorithm
  const thirdPlaceAssignments = assignThirdPlaceTeams(prediction, template);

  return {
    matches: template.matches.map((match) => ({
      ...match,
      homeTeamId: resolveSlotTeamId(match.homeSlot, prediction, template, thirdPlaceAssignments),
      awayTeamId: resolveSlotTeamId(match.awaySlot, prediction, template, thirdPlaceAssignments),
    })),
  };
};

export type TeamId = string;

export interface Team {
  id: TeamId;
  name: string;
  shortName?: string;
  flagEmoji?: string;
  confederation?: "UEFA" | "CONMEBOL" | "CONCACAF" | "CAF" | "AFC" | "OFC";
  fifaRank?: number;
}

export type GroupId =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L";

export type GroupPosition = 1 | 2 | 3 | 4;

export interface Group {
  id: GroupId;
  teams: TeamId[];
}

export interface GroupPrediction {
  groupId: GroupId;
  positions: Record<GroupPosition, TeamId>;
}

export interface ThirdPlaceSelection {
  advancingThirdPlaceTeamIds: TeamId[]; // exactly 8
}

export type KnockoutRound = "R32" | "R16" | "QF" | "SF" | "F";

export interface KnockoutSlotSource_GroupPosition {
  type: "group-position";
  groupId: GroupId;
  position: 1 | 2 | 3;
}

export interface KnockoutSlotSource_ThirdRanked {
  type: "third-ranked";
  rankIndex: number; // 0-7, ordered by qualification combinations
  groupCombination?: string; // e.g., "CDFGH", "CDFHI", etc.
}

export interface KnockoutSlotSource_MatchWinner {
  type: "winner-of-match";
  matchId: string;
}

export type KnockoutSlotSource =
  | KnockoutSlotSource_GroupPosition
  | KnockoutSlotSource_ThirdRanked
  | KnockoutSlotSource_MatchWinner;

export interface KnockoutSlot {
  id: string;
  round: KnockoutRound;
  label: string;
  source?: KnockoutSlotSource;
}

export interface MatchMetadata {
  stadium?: string;
  city?: string;
  date?: string;
  fifaUrl?: string;
}

export interface Match {
  id: string;
  round: KnockoutRound;
  homeSlot: KnockoutSlot;
  awaySlot: KnockoutSlot;
  metadata?: MatchMetadata;
}

export interface Bracket {
  matches: Match[];
}

export interface ResolvedMatch extends Match {
  homeTeamId?: TeamId;
  awayTeamId?: TeamId;
}

export interface ResolvedBracket extends Bracket {
  matches: ResolvedMatch[];
}

export interface KnockoutPrediction {
  winnersByMatchId: Record<string, TeamId | undefined>;
}

export interface WorldCupPrediction {
  groups: GroupPrediction[];
  thirdPlaceSelection: ThirdPlaceSelection;
  knockout: KnockoutPrediction;
}


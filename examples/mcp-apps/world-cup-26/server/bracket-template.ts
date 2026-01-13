import {
  Bracket,
  KnockoutSlot,
  KnockoutSlotSource,
  KnockoutRound,
  Match,
} from "../shared/types";

const slot = (
  id: string,
  round: KnockoutRound,
  label: string,
  source?: KnockoutSlotSource
): KnockoutSlot => ({
  id,
  round,
  label,
  source,
});

const r32: Match[] = [
  // Match 1: 2A vs 2B (A2 vs B2)
  {
    id: "R32-M1",
    round: "R32",
    homeSlot: slot("R32-M1-H", "R32", "Group A 2nd", {
      type: "group-position",
      groupId: "A",
      position: 2,
    }),
    awaySlot: slot("R32-M1-A", "R32", "Group B 2nd", {
      type: "group-position",
      groupId: "B",
      position: 2,
    }),
    metadata: { city: "Los Angeles", stadium: "SoFi Stadium", date: "2026-06-13" },
  },
  // Match 2: 1C vs 2F (C1 vs F2)
  {
    id: "R32-M2",
    round: "R32",
    homeSlot: slot("R32-M2-H", "R32", "Group C 1st", {
      type: "group-position",
      groupId: "C",
      position: 1,
    }),
    awaySlot: slot("R32-M2-A", "R32", "Group F 2nd", {
      type: "group-position",
      groupId: "F",
      position: 2,
    }),
    metadata: { city: "Houston", stadium: "NRG Stadium", date: "2026-06-13" },
  },
  // Match 3: 1E vs 3ABCDF (E1 vs 3rd from ABCDF) - Pathway 1 Match 74
  {
    id: "R32-M3",
    round: "R32",
    homeSlot: slot("R32-M3-H", "R32", "Group E 1st", {
      type: "group-position",
      groupId: "E",
      position: 1,
    }),
    awaySlot: slot("R32-M3-A", "R32", "3rd-ranked (ABCDF)", {
      type: "third-ranked",
      rankIndex: 0,
      groupCombination: "ABCDF",
    }),
    metadata: { city: "Boston", stadium: "Gillette Stadium", date: "2026-06-13" },
  },
  // Match 4: 1F vs 2C (F1 vs C2) - Netherlands vs Morocco (C2 is Morocco)
  {
    id: "R32-M4",
    round: "R32",
    homeSlot: slot("R32-M4-H", "R32", "Group F 1st", {
      type: "group-position",
      groupId: "F",
      position: 1,
    }),
    awaySlot: slot("R32-M4-A", "R32", "Group C 2nd", {
      type: "group-position",
      groupId: "C",
      position: 2,
    }),
    metadata: { city: "Monterrey", stadium: "Estadio BBVA", date: "2026-06-13" },
  },
  // Match 5: 2E vs 2I (E2 vs I2)
  {
    id: "R32-M5",
    round: "R32",
    homeSlot: slot("R32-M5-H", "R32", "Group E 2nd", {
      type: "group-position",
      groupId: "E",
      position: 2,
    }),
    awaySlot: slot("R32-M5-A", "R32", "Group I 2nd", {
      type: "group-position",
      groupId: "I",
      position: 2,
    }),
    metadata: { city: "Dallas", stadium: "AT&T Stadium", date: "2026-06-14" },
  },
  // Match 6: 1I vs 3CDFGH (I1 vs 3rd from CDFGH) - Pathway 1 Match 77
  {
    id: "R32-M6",
    round: "R32",
    homeSlot: slot("R32-M6-H", "R32", "Group I 1st", {
      type: "group-position",
      groupId: "I",
      position: 1,
    }),
    awaySlot: slot("R32-M6-A", "R32", "3rd-ranked (CDFGH)", {
      type: "third-ranked",
      rankIndex: 1,
      groupCombination: "CDFGH",
    }),
    metadata: { city: "New York", stadium: "MetLife", date: "2026-06-14" },
  },
  // Match 7: 1A vs 3CEFHI (A1 vs 3rd from CEFHI)
  {
    id: "R32-M7",
    round: "R32",
    homeSlot: slot("R32-M7-H", "R32", "Group A 1st", {
      type: "group-position",
      groupId: "A",
      position: 1,
    }),
    awaySlot: slot("R32-M7-A", "R32", "3rd-ranked (CEFHI)", {
      type: "third-ranked",
      rankIndex: 2,
      groupCombination: "CEFHI",
    }),
    metadata: { city: "Mexico City", stadium: "Azteca", date: "2026-06-14" },
  },
  // Match 8: 1L vs 3EHIJK (L1 vs 3rd from EHIJK)
  {
    id: "R32-M8",
    round: "R32",
    homeSlot: slot("R32-M8-H", "R32", "Group L 1st", {
      type: "group-position",
      groupId: "L",
      position: 1,
    }),
    awaySlot: slot("R32-M8-A", "R32", "3rd-ranked (EHIJK)", {
      type: "third-ranked",
      rankIndex: 6,
      groupCombination: "EHIJK",
    }),
    metadata: { city: "Atlanta", stadium: "Mercedes-Benz", date: "2026-06-15" },
  },
  // Match 9: 1G vs 3AEHIJ (G1 vs 3rd from AEHIJ)
  {
    id: "R32-M9",
    round: "R32",
    homeSlot: slot("R32-M9-H", "R32", "Group G 1st", {
      type: "group-position",
      groupId: "G",
      position: 1,
    }),
    awaySlot: slot("R32-M9-A", "R32", "3rd-ranked (AEHIJ)", {
      type: "third-ranked",
      rankIndex: 4,
      groupCombination: "AEHIJ",
    }),
    metadata: { city: "Seattle", stadium: "Lumen Field", date: "2026-06-15" },
  },
  // Match 10: 1D vs 3BEFIJ (D1 vs 3rd from BEFIJ) - Pathway 1 Match 81
  {
    id: "R32-M10",
    round: "R32",
    homeSlot: slot("R32-M10-H", "R32", "Group D 1st", {
      type: "group-position",
      groupId: "D",
      position: 1,
    }),
    awaySlot: slot("R32-M10-A", "R32", "3rd-ranked (BEFIJ)", {
      type: "third-ranked",
      rankIndex: 3,
      groupCombination: "BEFIJ",
    }),
    metadata: { city: "San Francisco", stadium: "Levi's Stadium", date: "2026-06-15" },
  },
  // Match 11: 1H vs 2J (H1 vs J2)
  {
    id: "R32-M11",
    round: "R32",
    homeSlot: slot("R32-M11-H", "R32", "Group H 1st", {
      type: "group-position",
      groupId: "H",
      position: 1,
    }),
    awaySlot: slot("R32-M11-A", "R32", "Group J 2nd", {
      type: "group-position",
      groupId: "J",
      position: 2,
    }),
    metadata: { city: "Los Angeles", stadium: "SoFi Stadium", date: "2026-06-16" },
  },
  // Match 12: 2K vs 2L (K2 vs L2)
  {
    id: "R32-M12",
    round: "R32",
    homeSlot: slot("R32-M12-H", "R32", "Group K 2nd", {
      type: "group-position",
      groupId: "K",
      position: 2,
    }),
    awaySlot: slot("R32-M12-A", "R32", "Group L 2nd", {
      type: "group-position",
      groupId: "L",
      position: 2,
    }),
    metadata: { city: "Toronto", stadium: "BMO Field", date: "2026-06-16" },
  },
  // Match 13: 1B vs 3EFGIJ (B1 vs 3rd from EFGIJ)
  {
    id: "R32-M13",
    round: "R32",
    homeSlot: slot("R32-M13-H", "R32", "Group B 1st", {
      type: "group-position",
      groupId: "B",
      position: 1,
    }),
    awaySlot: slot("R32-M13-A", "R32", "3rd-ranked (EFGIJ)", {
      type: "third-ranked",
      rankIndex: 5,
      groupCombination: "EFGIJ",
    }),
    metadata: { city: "Vancouver", stadium: "BC Place", date: "2026-06-16" },
  },
  // Match 14: 2D vs 2G (D2 vs G2)
  {
    id: "R32-M14",
    round: "R32",
    homeSlot: slot("R32-M14-H", "R32", "Group D 2nd", {
      type: "group-position",
      groupId: "D",
      position: 2,
    }),
    awaySlot: slot("R32-M14-A", "R32", "Group G 2nd", {
      type: "group-position",
      groupId: "G",
      position: 2,
    }),
    metadata: { city: "Dallas", stadium: "AT&T Stadium", date: "2026-06-17" },
  },
  // Match 15: 1J vs 2H (J1 vs H2)
  {
    id: "R32-M15",
    round: "R32",
    homeSlot: slot("R32-M15-H", "R32", "Group J 1st", {
      type: "group-position",
      groupId: "J",
      position: 1,
    }),
    awaySlot: slot("R32-M15-A", "R32", "Group H 2nd", {
      type: "group-position",
      groupId: "H",
      position: 2,
    }),
    metadata: { city: "Miami", stadium: "Hard Rock Stadium", date: "2026-06-17" },
  },
  // Match 16: 1K vs 3DEIJL (K1 vs 3rd from DEIJL)
  {
    id: "R32-M16",
    round: "R32",
    homeSlot: slot("R32-M16-H", "R32", "Group K 1st", {
      type: "group-position",
      groupId: "K",
      position: 1,
    }),
    awaySlot: slot("R32-M16-A", "R32", "3rd-ranked (DEIJL)", {
      type: "third-ranked",
      rankIndex: 7,
      groupCombination: "DEIJL",
    }),
    metadata: { city: "Kansas City", stadium: "Arrowhead", date: "2026-06-17" },
  },
];

const r16: Match[] = [
  {
    id: "R16-M1",
    round: "R16",
    homeSlot: slot("R16-M1-H", "R16", "Winner R32-M1", { type: "winner-of-match", matchId: "R32-M1" }),
    awaySlot: slot("R16-M1-A", "R16", "Winner R32-M3", { type: "winner-of-match", matchId: "R32-M3" }),
    metadata: { city: "Los Angeles", stadium: "SoFi Stadium", date: "2026-06-23" },
  },
  {
    id: "R16-M2",
    round: "R16",
    homeSlot: slot("R16-M2-H", "R16", "Winner R32-M4", { type: "winner-of-match", matchId: "R32-M4" }),
    awaySlot: slot("R16-M2-A", "R16", "Winner R32-M6", { type: "winner-of-match", matchId: "R32-M6" }),
    metadata: { city: "Mexico City", stadium: "Azteca", date: "2026-06-23" },
  },
  {
    id: "R16-M3",
    round: "R16",
    homeSlot: slot("R16-M3-H", "R16", "Winner R32-M2", { type: "winner-of-match", matchId: "R32-M2" }),
    awaySlot: slot("R16-M3-A", "R16", "Winner R32-M5", { type: "winner-of-match", matchId: "R32-M5" }),
    metadata: { city: "Atlanta", stadium: "Mercedes-Benz", date: "2026-06-24" },
  },
  {
    id: "R16-M4",
    round: "R16",
    homeSlot: slot("R16-M4-H", "R16", "Winner R32-M7", { type: "winner-of-match", matchId: "R32-M7" }),
    awaySlot: slot("R16-M4-A", "R16", "Winner R32-M8", { type: "winner-of-match", matchId: "R32-M8" }),
    metadata: { city: "Houston", stadium: "NRG Stadium", date: "2026-06-24" },
  },
  {
    id: "R16-M5",
    round: "R16",
    homeSlot: slot("R16-M5-H", "R16", "Winner R32-M9", { type: "winner-of-match", matchId: "R32-M9" }),
    awaySlot: slot("R16-M5-A", "R16", "Winner R32-M10", { type: "winner-of-match", matchId: "R32-M10" }),
    metadata: { city: "Dallas", stadium: "AT&T Stadium", date: "2026-06-25" },
  },
  {
    id: "R16-M6",
    round: "R16",
    homeSlot: slot("R16-M6-H", "R16", "Winner R32-M11", { type: "winner-of-match", matchId: "R32-M11" }),
    awaySlot: slot("R16-M6-A", "R16", "Winner R32-M12", { type: "winner-of-match", matchId: "R32-M12" }),
    metadata: { city: "Toronto", stadium: "BMO Field", date: "2026-06-25" },
  },
  {
    id: "R16-M7",
    round: "R16",
    homeSlot: slot("R16-M7-H", "R16", "Winner R32-M13", { type: "winner-of-match", matchId: "R32-M13" }),
    awaySlot: slot("R16-M7-A", "R16", "Winner R32-M14", { type: "winner-of-match", matchId: "R32-M14" }),
    metadata: { city: "Seattle", stadium: "Lumen Field", date: "2026-06-26" },
  },
  {
    id: "R16-M8",
    round: "R16",
    homeSlot: slot("R16-M8-H", "R16", "Winner R32-M15", { type: "winner-of-match", matchId: "R32-M15" }),
    awaySlot: slot("R16-M8-A", "R16", "Winner R32-M16", { type: "winner-of-match", matchId: "R32-M16" }),
    metadata: { city: "San Francisco", stadium: "Levi's Stadium", date: "2026-06-26" },
  },
];

const qf: Match[] = [
  {
    id: "QF-M1",
    round: "QF",
    homeSlot: slot("QF-M1-H", "QF", "Winner R16-M1", { type: "winner-of-match", matchId: "R16-M1" }),
    awaySlot: slot("QF-M1-A", "QF", "Winner R16-M2", { type: "winner-of-match", matchId: "R16-M2" }),
    metadata: { city: "Boston", stadium: "Gillette Stadium", date: "2026-06-29" },
  },
  {
    id: "QF-M2",
    round: "QF",
    homeSlot: slot("QF-M2-H", "QF", "Winner R16-M5", { type: "winner-of-match", matchId: "R16-M5" }),
    awaySlot: slot("QF-M2-A", "QF", "Winner R16-M6", { type: "winner-of-match", matchId: "R16-M6" }),
    metadata: { city: "Miami", stadium: "Hard Rock Stadium", date: "2026-06-29" },
  },
  {
    id: "QF-M3",
    round: "QF",
    homeSlot: slot("QF-M3-H", "QF", "Winner R16-M3", { type: "winner-of-match", matchId: "R16-M3" }),
    awaySlot: slot("QF-M3-A", "QF", "Winner R16-M4", { type: "winner-of-match", matchId: "R16-M4" }),
    metadata: { city: "Philadelphia", stadium: "Lincoln Financial Field", date: "2026-06-30" },
  },
  {
    id: "QF-M4",
    round: "QF",
    homeSlot: slot("QF-M4-H", "QF", "Winner R16-M7", { type: "winner-of-match", matchId: "R16-M7" }),
    awaySlot: slot("QF-M4-A", "QF", "Winner R16-M8", { type: "winner-of-match", matchId: "R16-M8" }),
    metadata: { city: "Toronto", stadium: "BMO Field", date: "2026-06-30" },
  },
];

const sf: Match[] = [
  {
    id: "SF-M1",
    round: "SF",
    homeSlot: slot("SF-M1-H", "SF", "Winner QF-M1", { type: "winner-of-match", matchId: "QF-M1" }),
    awaySlot: slot("SF-M1-A", "SF", "Winner QF-M2", { type: "winner-of-match", matchId: "QF-M2" }),
    metadata: { city: "New York", stadium: "MetLife", date: "2026-07-04" },
  },
  {
    id: "SF-M2",
    round: "SF",
    homeSlot: slot("SF-M2-H", "SF", "Winner QF-M3", { type: "winner-of-match", matchId: "QF-M3" }),
    awaySlot: slot("SF-M2-A", "SF", "Winner QF-M4", { type: "winner-of-match", matchId: "QF-M4" }),
    metadata: { city: "Los Angeles", stadium: "SoFi Stadium", date: "2026-07-05" },
  },
];

const finals: Match[] = [
  {
    id: "F-M1",
    round: "F",
    homeSlot: slot("F-M1-H", "F", "Winner SF-M1", { type: "winner-of-match", matchId: "SF-M1" }),
    awaySlot: slot("F-M1-A", "F", "Winner SF-M2", { type: "winner-of-match", matchId: "SF-M2" }),
    metadata: { city: "Miami", stadium: "Hard Rock Stadium", date: "2026-07-12" },
  },
];

export const bracketTemplate: Bracket = {
  matches: [...r32, ...r16, ...qf, ...sf, ...finals],
};


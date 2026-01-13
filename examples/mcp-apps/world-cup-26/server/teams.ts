import { Group, GroupId, Team } from "../shared/types";

export const teams: Team[] = [
  // CONCACAF
  { id: "mexico", name: "Mexico", shortName: "MEX", flagEmoji: "🇲🇽", confederation: "CONCACAF" },
  { id: "usa", name: "United States", shortName: "USA", flagEmoji: "🇺🇸", confederation: "CONCACAF" },
  { id: "canada", name: "Canada", shortName: "CAN", flagEmoji: "🇨🇦", confederation: "CONCACAF" },
  { id: "panama", name: "Panama", shortName: "PAN", flagEmoji: "🇵🇦", confederation: "CONCACAF" },
  { id: "haiti", name: "Haiti", shortName: "HAI", flagEmoji: "🇭🇹", confederation: "CONCACAF" },
  { id: "curacao", name: "Curaçao", shortName: "CUW", flagEmoji: "🇨🇼", confederation: "CONCACAF" },

  // CONMEBOL
  { id: "brazil", name: "Brazil", shortName: "BRA", flagEmoji: "🇧🇷", confederation: "CONMEBOL" },
  { id: "argentina", name: "Argentina", shortName: "ARG", flagEmoji: "🇦🇷", confederation: "CONMEBOL" },
  { id: "uruguay", name: "Uruguay", shortName: "URU", flagEmoji: "🇺🇾", confederation: "CONMEBOL" },
  { id: "colombia", name: "Colombia", shortName: "COL", flagEmoji: "🇨🇴", confederation: "CONMEBOL" },
  { id: "ecuador", name: "Ecuador", shortName: "ECU", flagEmoji: "🇪🇨", confederation: "CONMEBOL" },
  { id: "paraguay", name: "Paraguay", shortName: "PAR", flagEmoji: "🇵🇾", confederation: "CONMEBOL" },

  // UEFA - Qualified
  { id: "germany", name: "Germany", shortName: "GER", flagEmoji: "🇩🇪", confederation: "UEFA" },
  { id: "spain", name: "Spain", shortName: "ESP", flagEmoji: "🇪🇸", confederation: "UEFA" },
  { id: "france", name: "France", shortName: "FRA", flagEmoji: "🇫🇷", confederation: "UEFA" },
  { id: "england", name: "England", shortName: "ENG", flagEmoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", confederation: "UEFA" },
  { id: "portugal", name: "Portugal", shortName: "POR", flagEmoji: "🇵🇹", confederation: "UEFA" },
  { id: "netherlands", name: "Netherlands", shortName: "NED", flagEmoji: "🇳🇱", confederation: "UEFA" },
  { id: "belgium", name: "Belgium", shortName: "BEL", flagEmoji: "🇧🇪", confederation: "UEFA" },
  { id: "croatia", name: "Croatia", shortName: "CRO", flagEmoji: "🇭🇷", confederation: "UEFA" },
  { id: "switzerland", name: "Switzerland", shortName: "SUI", flagEmoji: "🇨🇭", confederation: "UEFA" },
  { id: "scotland", name: "Scotland", shortName: "SCO", flagEmoji: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", confederation: "UEFA" },
  { id: "austria", name: "Austria", shortName: "AUT", flagEmoji: "🇦🇹", confederation: "UEFA" },
  { id: "norway", name: "Norway", shortName: "NOR", flagEmoji: "🇳🇴", confederation: "UEFA" },

  // UEFA Playoff A candidates: Italy, Northern Ireland, Wales, Bosnia & Herzegovina
  { id: "italy", name: "Italy", shortName: "ITA", flagEmoji: "🇮🇹", confederation: "UEFA" },
  { id: "northern-ireland", name: "Northern Ireland", shortName: "NIR", flagEmoji: "🇬🇧", confederation: "UEFA" },
  { id: "wales", name: "Wales", shortName: "WAL", flagEmoji: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", confederation: "UEFA" },
  { id: "bosnia", name: "Bosnia & Herzegovina", shortName: "BIH", flagEmoji: "🇧🇦", confederation: "UEFA" },

  // UEFA Playoff B candidates: Ukraine, Sweden, Poland, Albania
  { id: "ukraine", name: "Ukraine", shortName: "UKR", flagEmoji: "🇺🇦", confederation: "UEFA" },
  { id: "sweden", name: "Sweden", shortName: "SWE", flagEmoji: "🇸🇪", confederation: "UEFA" },
  { id: "poland", name: "Poland", shortName: "POL", flagEmoji: "🇵🇱", confederation: "UEFA" },
  { id: "albania", name: "Albania", shortName: "ALB", flagEmoji: "🇦🇱", confederation: "UEFA" },

  // UEFA Playoff C candidates: Turkey, Romania, Slovakia, Kosovo
  { id: "turkey", name: "Turkey", shortName: "TUR", flagEmoji: "🇹🇷", confederation: "UEFA" },
  { id: "romania", name: "Romania", shortName: "ROU", flagEmoji: "🇷🇴", confederation: "UEFA" },
  { id: "slovakia", name: "Slovakia", shortName: "SVK", flagEmoji: "🇸🇰", confederation: "UEFA" },
  { id: "kosovo", name: "Kosovo", shortName: "KOS", flagEmoji: "🇽🇰", confederation: "UEFA" },

  // UEFA Playoff D candidates: Denmark, North Macedonia, Czechia, Ireland
  { id: "denmark", name: "Denmark", shortName: "DEN", flagEmoji: "🇩🇰", confederation: "UEFA" },
  { id: "north-macedonia", name: "North Macedonia", shortName: "MKD", flagEmoji: "🇲🇰", confederation: "UEFA" },
  { id: "czechia", name: "Czechia", shortName: "CZE", flagEmoji: "🇨🇿", confederation: "UEFA" },
  { id: "ireland", name: "Ireland", shortName: "IRL", flagEmoji: "🇮🇪", confederation: "UEFA" },

  // CAF
  { id: "morocco", name: "Morocco", shortName: "MAR", flagEmoji: "🇲🇦", confederation: "CAF" },
  { id: "south-africa", name: "South Africa", shortName: "RSA", flagEmoji: "🇿🇦", confederation: "CAF" },
  { id: "egypt", name: "Egypt", shortName: "EGY", flagEmoji: "🇪🇬", confederation: "CAF" },
  { id: "senegal", name: "Senegal", shortName: "SEN", flagEmoji: "🇸🇳", confederation: "CAF" },
  { id: "ivory-coast", name: "Ivory Coast", shortName: "CIV", flagEmoji: "🇨🇮", confederation: "CAF" },
  { id: "ghana", name: "Ghana", shortName: "GHA", flagEmoji: "🇬🇭", confederation: "CAF" },
  { id: "algeria", name: "Algeria", shortName: "ALG", flagEmoji: "🇩🇿", confederation: "CAF" },
  { id: "tunisia", name: "Tunisia", shortName: "TUN", flagEmoji: "🇹🇳", confederation: "CAF" },
  { id: "cape-verde", name: "Cape Verde", shortName: "CPV", flagEmoji: "🇨🇻", confederation: "CAF" },
  { id: "dr-congo", name: "DR Congo", shortName: "COD", flagEmoji: "🇨🇩", confederation: "CAF" },

  // AFC
  { id: "japan", name: "Japan", shortName: "JPN", flagEmoji: "🇯🇵", confederation: "AFC" },
  { id: "south-korea", name: "South Korea", shortName: "KOR", flagEmoji: "🇰🇷", confederation: "AFC" },
  { id: "australia", name: "Australia", shortName: "AUS", flagEmoji: "🇦🇺", confederation: "AFC" },
  { id: "saudi-arabia", name: "Saudi Arabia", shortName: "KSA", flagEmoji: "🇸🇦", confederation: "AFC" },
  { id: "iran", name: "Iran", shortName: "IRN", flagEmoji: "🇮🇷", confederation: "AFC" },
  { id: "qatar", name: "Qatar", shortName: "QAT", flagEmoji: "🇶🇦", confederation: "AFC" },
  { id: "uzbekistan", name: "Uzbekistan", shortName: "UZB", flagEmoji: "🇺🇿", confederation: "AFC" },
  { id: "jordan", name: "Jordan", shortName: "JOR", flagEmoji: "🇯🇴", confederation: "AFC" },
  { id: "iraq", name: "Iraq", shortName: "IRQ", flagEmoji: "🇮🇶", confederation: "AFC" },

  // OFC
  { id: "new-zealand", name: "New Zealand", shortName: "NZL", flagEmoji: "🇳🇿", confederation: "OFC" },
  { id: "new-caledonia", name: "New Caledonia", shortName: "NCL", flagEmoji: "🇳🇨", confederation: "OFC" },

  // Other playoff candidates
  { id: "jamaica", name: "Jamaica", shortName: "JAM", flagEmoji: "🇯🇲", confederation: "CONCACAF" },
  { id: "suriname", name: "Suriname", shortName: "SUR", flagEmoji: "🇸🇷", confederation: "CONMEBOL" },
  { id: "bolivia", name: "Bolivia", shortName: "BOL", flagEmoji: "🇧🇴", confederation: "CONMEBOL" },
];

// Playoff slot definitions - which teams can fill each playoff spot
export const playoffSlots: Record<string, string[]> = {
  "euro-playoff-a": ["italy", "northern-ireland", "wales", "bosnia"],
  "euro-playoff-b": ["ukraine", "sweden", "poland", "albania"],
  "euro-playoff-c": ["turkey", "romania", "slovakia", "kosovo"],
  "euro-playoff-d": ["denmark", "north-macedonia", "czechia", "ireland"],
  "intercon-playoff-1": ["jamaica", "new-caledonia", "dr-congo"],
  "intercon-playoff-2": ["bolivia", "suriname", "iraq"],
};

// Official 2026 FIFA World Cup Groups (from December 5, 2025 draw)
// Playoff slots will be replaced by user's prediction
export const groups: Group[] = [
  { id: "A", teams: ["mexico", "south-africa", "south-korea", "euro-playoff-d"] },
  { id: "B", teams: ["canada", "euro-playoff-a", "qatar", "switzerland"] },
  { id: "C", teams: ["brazil", "morocco", "haiti", "scotland"] },
  { id: "D", teams: ["usa", "paraguay", "australia", "euro-playoff-c"] },
  { id: "E", teams: ["germany", "curacao", "ivory-coast", "ecuador"] },
  { id: "F", teams: ["netherlands", "japan", "euro-playoff-b", "tunisia"] },
  { id: "G", teams: ["belgium", "egypt", "iran", "new-zealand"] },
  { id: "H", teams: ["spain", "cape-verde", "saudi-arabia", "uruguay"] },
  { id: "I", teams: ["france", "senegal", "intercon-playoff-2", "norway"] },
  { id: "J", teams: ["argentina", "algeria", "austria", "jordan"] },
  { id: "K", teams: ["portugal", "intercon-playoff-1", "uzbekistan", "colombia"] },
  { id: "L", teams: ["england", "croatia", "ghana", "panama"] },
];

export const teamById: Record<string, Team> = teams.reduce<Record<string, Team>>(
  (acc, team) => {
    acc[team.id] = team;
    return acc;
  },
  {}
);

export const groupOrder: GroupId[] = groups.map((g) => g.id);

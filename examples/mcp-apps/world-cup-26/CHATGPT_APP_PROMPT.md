# World Cup 2026 Bracket Predictor - ChatGPT App Build Prompt

Build a complete ChatGPT App for predicting the 2026 FIFA World Cup bracket. This is a standalone web application that allows users to predict group stage results, select advancing third-place teams, and fill out the complete knockout bracket.

## Project Overview

Create a web application that enables users to:
1. Predict group stage positions (1st-4th) for all 12 groups (A-L)
2. Select 8 of 12 third-place teams to advance to Round of 32
3. View and interact with the complete knockout bracket (R32 → R16 → QF → SF → Final)
4. Make winner predictions for each knockout match
5. Save and load predictions

## Tech Stack

- **Frontend Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **UI Components**: Radix UI, Framer Motion, Lucide React
- **State Management**: React hooks (useState, useEffect)
- **Data Persistence**: LocalStorage (or ChatGPT App storage API if available)
- **Zoom Library**: react-zoom-pan-pinch or similar for mouse wheel zoom

## Core Features

### 1. Group Stage Predictions
- Display all 12 groups (A-L) with 4 teams each
- Allow users to assign positions 1-4 for each team in each group
- Visual feedback for completed groups

### 2. Third-Place Team Selection
- Display all 12 third-place teams (one from each group)
- Allow users to select exactly 8 teams to advance
- Show selected teams in ranked order (best → worst)
- Visual indication of selection state

### 3. Constraint-Satisfaction Solver for Third-Place Assignment
**Critical Algorithm**: Implement a backtracking constraint-satisfaction solver to assign the 8 qualified third-place teams to Round-of-32 slots.

**Input**:
- Exactly 8 qualified third-place teams, each with:
  - `id`: TeamId (string)
  - `groupLetter`: GroupId ("A" through "L")
- 8 slots with constraints:
  - `R32-M3-A`: allowed letters "ABCDF"
  - `R32-M6-A`: allowed letters "CDFGH"
  - `R32-M7-A`: allowed letters "CEFHI"
  - `R32-M10-A`: allowed letters "BEFIJ"
  - `R32-M9-A`: allowed letters "AEHIJ"
  - `R32-M13-A`: allowed letters "EFGIJ"
  - `R32-M8-A`: allowed letters "EHIJK"
  - `R32-M16-A`: allowed letters "DEIJL"

**Constraints**:
- Each team can only be assigned to a slot if `slot.letters.includes(team.groupLetter)`
- Each team must be assigned to exactly one slot
- Each slot must receive exactly one team
- No padding or fallback that violates constraints

**Algorithm**:
- Use backtracking DFS with MRV (Minimum Remaining Values) heuristic
- Select the slot with fewest candidates first
- Try teams in ranked order (best → worst) for deterministic output
- If no solution exists, throw a detailed error with debug info

**Output**: `Map<slotId, teamId>` mapping each slot to its assigned team

### 4. Knockout Bracket View
- **Full bracket view**: Display the entire tournament bracket from Round of 32 through Final in a single view
- **Traditional tournament tree layout**: Vertical layout with left-to-right progression (R32 on left, Final on right)
- **Interactive match cards**: Click to select winners
- **Visual connections**: Show how winners advance through rounds
- **Match metadata**: Display stadium, city, date for each match
- **Team display**: Show team flags (emoji), names, and short names

### 5. Zoom Functionality
- **Mouse wheel zoom**: Scroll up to zoom in, scroll down to zoom out
- **Pan support**: Click and drag to pan around the bracket when zoomed in
- **Zoom limits**: Minimum zoom (fit to viewport) and maximum zoom (e.g., 3x)
- **Smooth transitions**: Use CSS transforms or a zoom library for smooth zooming
- **Reset button**: Optional button to reset zoom and pan to default view

### 6. Save/Load Functionality
- Save predictions to localStorage (or ChatGPT App storage)
- Load saved predictions on app start
- Clear/reset functionality

## Data Structures

### Team
```typescript
interface Team {
  id: string; // e.g., "mexico", "argentina"
  name: string; // e.g., "Mexico", "Argentina"
  shortName?: string; // e.g., "MEX", "ARG"
  flagEmoji?: string; // e.g., "🇲🇽", "🇦🇷"
  confederation?: "UEFA" | "CONMEBOL" | "CONCACAF" | "CAF" | "AFC" | "OFC";
  fifaRank?: number;
}
```

### Group Prediction
```typescript
type GroupId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";
type GroupPosition = 1 | 2 | 3 | 4;

interface GroupPrediction {
  groupId: GroupId;
  positions: Record<GroupPosition, string>; // TeamId for each position
}
```

### Third-Place Selection
```typescript
interface ThirdPlaceSelection {
  advancingThirdPlaceTeamIds: string[]; // Exactly 8 TeamIds, ordered best→worst
}
```

### Knockout Prediction
```typescript
interface KnockoutPrediction {
  winnersByMatchId: Record<string, string | undefined>; // matchId → TeamId
}
```

### Complete Prediction
```typescript
interface WorldCupPrediction {
  groups: GroupPrediction[]; // 12 groups
  thirdPlaceSelection: ThirdPlaceSelection;
  knockout: KnockoutPrediction;
}
```

### Match and Bracket
```typescript
type KnockoutRound = "R32" | "R16" | "QF" | "SF" | "F";

interface KnockoutSlotSource {
  type: "group-position" | "third-ranked" | "winner-of-match";
  // For group-position:
  groupId?: GroupId;
  position?: 1 | 2 | 3;
  // For third-ranked:
  slotId?: string; // e.g., "R32-M3-A"
  // For winner-of-match:
  matchId?: string; // e.g., "R32-M1"
}

interface KnockoutSlot {
  id: string; // e.g., "R32-M1-H", "R32-M3-A"
  round: KnockoutRound;
  label: string; // e.g., "Group A 1st", "3rd-ranked (ABCDF)"
  source?: KnockoutSlotSource;
}

interface Match {
  id: string; // e.g., "R32-M1", "R16-M1"
  round: KnockoutRound;
  homeSlot: KnockoutSlot;
  awaySlot: KnockoutSlot;
  metadata?: {
    stadium?: string;
    city?: string;
    date?: string;
  };
}

interface Bracket {
  matches: Match[];
}

interface ResolvedMatch extends Match {
  homeTeamId?: string;
  awayTeamId?: string;
}

interface ResolvedBracket extends Bracket {
  matches: ResolvedMatch[];
}
```

## Bracket Structure

### Round of 32 (16 matches)
The bracket template defines 16 matches with specific slot sources:
- Direct group positions: e.g., "Group A 1st" vs "Group B 2nd"
- Third-place slots: e.g., "3rd-ranked (ABCDF)" - these use the constraint solver

Key R32 matches:
- R32-M1: A2 vs B2
- R32-M2: C1 vs F2
- R32-M3: E1 vs 3ABCDF (third-place slot)
- R32-M4: F1 vs C2
- R32-M5: E2 vs I2
- R32-M6: I1 vs 3CDFGH (third-place slot)
- R32-M7: A1 vs 3CEFHI (third-place slot)
- R32-M8: L1 vs 3EHIJK (third-place slot)
- R32-M9: G1 vs 3AEHIJ (third-place slot)
- R32-M10: D1 vs 3BEFIJ (third-place slot)
- R32-M11: H1 vs J2
- R32-M12: K2 vs L2
- R32-M13: B1 vs 3EFGIJ (third-place slot)
- R32-M14: D2 vs G2
- R32-M15: J1 vs H2
- R32-M16: K1 vs 3DEIJL (third-place slot)

### Round of 16 (8 matches)
- R16-M1: Winner R32-M1 vs Winner R32-M3
- R16-M2: Winner R32-M4 vs Winner R32-M6
- R16-M3: Winner R32-M2 vs Winner R32-M5
- R16-M4: Winner R32-M7 vs Winner R32-M8
- R16-M5: Winner R32-M9 vs Winner R32-M10
- R16-M6: Winner R32-M11 vs Winner R32-M12
- R16-M7: Winner R32-M13 vs Winner R32-M14
- R16-M8: Winner R32-M15 vs Winner R32-M16

### Quarterfinals (4 matches)
- QF-M1: Winner R16-M1 vs Winner R16-M2
- QF-M2: Winner R16-M5 vs Winner R16-M6
- QF-M3: Winner R16-M3 vs Winner R16-M4
- QF-M4: Winner R16-M7 vs Winner R16-M8

### Semifinals (2 matches)
- SF-M1: Winner QF-M1 vs Winner QF-M2
- SF-M2: Winner QF-M3 vs Winner QF-M4

### Final (1 match)
- F-M1: Winner SF-M1 vs Winner SF-M2

## Implementation Requirements

### 1. Bracket Resolution Logic
Create a function `resolveBracket(template: Bracket, prediction: WorldCupPrediction): ResolvedBracket` that:
1. Calls the constraint-satisfaction solver to assign third-place teams to slots
2. Resolves each match slot:
   - `group-position`: Look up team from `prediction.groups`
   - `third-ranked`: Look up from the solver's assignment map
   - `winner-of-match`: Look up from `prediction.knockout.winnersByMatchId`
3. Returns a `ResolvedBracket` with `homeTeamId` and `awayTeamId` populated

### 2. UI Components

#### GroupSelector
- Grid layout showing all 12 groups
- For each group, show 4 teams with drag-and-drop or click-to-assign position
- Visual feedback for completed groups

#### ThirdPlaceSelector
- List all 12 third-place teams (from group predictions)
- Allow selection of exactly 8 teams
- Show selected teams in ranked order
- Disable/enable selection based on count

#### BracketView (Full View with Zoom)
- **Container**: Use a zoom library (e.g., `react-zoom-pan-pinch`) or implement custom zoom
- **Layout**: Traditional tournament tree (vertical, left-to-right)
  - R32 matches on the left
  - R16 matches in the middle-left
  - QF matches in the middle
  - SF matches in the middle-right
  - Final on the right
- **Match Cards**: 
  - Show home and away teams with flags and names
  - Click to select winner (highlight selected)
  - Show match metadata (stadium, city, date)
  - Visual connections showing advancement paths
- **Zoom Controls**:
  - Mouse wheel: zoom in/out
  - Click and drag: pan when zoomed
  - Optional: zoom controls UI (zoom in/out/reset buttons)
- **Styling**: 
  - Use Tailwind CSS for styling
  - FIFA-inspired color scheme (blue, gold accents)
  - Glass-morphism effects for cards
  - Smooth animations with Framer Motion

### 3. State Management
- Use React Context or prop drilling for prediction state
- Persist to localStorage on changes
- Load from localStorage on mount

### 4. Error Handling
- Validate that exactly 8 third-place teams are selected before showing bracket
- Show error message if constraint solver fails (unsatisfiable constraints)
- Handle missing team data gracefully

## Teams Data

You'll need to create a teams array with all participating teams. Each team should have: `id`, `name`, `shortName`, `flagEmoji`, `confederation`.

### CONCACAF Teams
- **mexico** - Mexico (MEX) 🇲🇽 (host)
- **usa** - United States (USA) 🇺🇸 (host)
- **canada** - Canada (CAN) 🇨🇦 (host)
- **panama** - Panama (PAN) 🇵🇦
- **haiti** - Haiti (HAI) 🇭🇹
- **curacao** - Curaçao (CUW) 🇨🇼
- **jamaica** - Jamaica (JAM) 🇯🇲 (playoff candidate)

### CONMEBOL Teams
- **brazil** - Brazil (BRA) 🇧🇷
- **argentina** - Argentina (ARG) 🇦🇷
- **uruguay** - Uruguay (URU) 🇺🇾
- **colombia** - Colombia (COL) 🇨🇴
- **ecuador** - Ecuador (ECU) 🇪🇨
- **paraguay** - Paraguay (PAR) 🇵🇾
- **bolivia** - Bolivia (BOL) 🇧🇴 (playoff candidate)
- **suriname** - Suriname (SUR) 🇸🇷 (playoff candidate)

### UEFA Teams (Qualified)
- **germany** - Germany (GER) 🇩🇪
- **spain** - Spain (ESP) 🇪🇸
- **france** - France (FRA) 🇫🇷
- **england** - England (ENG) 🏴󠁧󠁢󠁥󠁮󠁧󠁿
- **portugal** - Portugal (POR) 🇵🇹
- **netherlands** - Netherlands (NED) 🇳🇱
- **belgium** - Belgium (BEL) 🇧🇪
- **croatia** - Croatia (CRO) 🇭🇷
- **switzerland** - Switzerland (SUI) 🇨🇭
- **scotland** - Scotland (SCO) 🏴󠁧󠁢󠁳󠁣󠁴󠁿
- **austria** - Austria (AUT) 🇦🇹
- **norway** - Norway (NOR) 🇳🇴

### UEFA Teams (Playoff Candidates)
- **italy** - Italy (ITA) 🇮🇹 (euro-playoff-a)
- **northern-ireland** - Northern Ireland (NIR) 🇬🇧 (euro-playoff-a)
- **wales** - Wales (WAL) 🏴󠁧󠁢󠁷󠁬󠁳󠁿 (euro-playoff-a)
- **bosnia** - Bosnia & Herzegovina (BIH) 🇧🇦 (euro-playoff-a)
- **ukraine** - Ukraine (UKR) 🇺🇦 (euro-playoff-b)
- **sweden** - Sweden (SWE) 🇸🇪 (euro-playoff-b)
- **poland** - Poland (POL) 🇵🇱 (euro-playoff-b)
- **albania** - Albania (ALB) 🇦🇱 (euro-playoff-b)
- **turkey** - Turkey (TUR) 🇹🇷 (euro-playoff-c)
- **romania** - Romania (ROU) 🇷🇴 (euro-playoff-c)
- **slovakia** - Slovakia (SVK) 🇸🇰 (euro-playoff-c)
- **kosovo** - Kosovo (KOS) 🇽🇰 (euro-playoff-c)
- **denmark** - Denmark (DEN) 🇩🇰 (euro-playoff-d)
- **north-macedonia** - North Macedonia (MKD) 🇲🇰 (euro-playoff-d)
- **czechia** - Czechia (CZE) 🇨🇿 (euro-playoff-d)
- **ireland** - Ireland (IRL) 🇮🇪 (euro-playoff-d)

### CAF Teams
- **morocco** - Morocco (MAR) 🇲🇦
- **south-africa** - South Africa (RSA) 🇿🇦
- **egypt** - Egypt (EGY) 🇪🇬
- **senegal** - Senegal (SEN) 🇸🇳
- **ivory-coast** - Ivory Coast (CIV) 🇨🇮
- **ghana** - Ghana (GHA) 🇬🇭
- **algeria** - Algeria (ALG) 🇩🇿
- **tunisia** - Tunisia (TUN) 🇹🇳
- **cape-verde** - Cape Verde (CPV) 🇨🇻
- **dr-congo** - DR Congo (COD) 🇨🇩 (playoff candidate)

### AFC Teams
- **japan** - Japan (JPN) 🇯🇵
- **south-korea** - South Korea (KOR) 🇰🇷
- **australia** - Australia (AUS) 🇦🇺
- **saudi-arabia** - Saudi Arabia (KSA) 🇸🇦
- **iran** - Iran (IRN) 🇮🇷
- **qatar** - Qatar (QAT) 🇶🇦
- **uzbekistan** - Uzbekistan (UZB) 🇺🇿
- **jordan** - Jordan (JOR) 🇯🇴
- **iraq** - Iraq (IRQ) 🇮🇶 (playoff candidate)

### OFC Teams
- **new-zealand** - New Zealand (NZL) 🇳🇿
- **new-caledonia** - New Caledonia (NCL) 🇳🇨 (playoff candidate)

## Official Group Assignments (December 5, 2025 Draw)

The 2026 FIFA World Cup has 12 groups (A-L) with 4 teams each. Some groups contain playoff slots that need to be resolved by the user. Here are the official group assignments:

### Group A
- **Mexico** (CONCACAF - host)
- **South Africa** (CAF)
- **South Korea** (AFC)
- **euro-playoff-d** (playoff slot - user must select one of: Denmark, North Macedonia, Czechia, Ireland)

### Group B
- **Canada** (CONCACAF - host)
- **euro-playoff-a** (playoff slot - user must select one of: Italy, Northern Ireland, Wales, Bosnia & Herzegovina)
- **Qatar** (AFC)
- **Switzerland** (UEFA)

### Group C
- **Brazil** (CONMEBOL)
- **Morocco** (CAF)
- **Haiti** (CONCACAF)
- **Scotland** (UEFA)

### Group D
- **United States** (CONCACAF - host)
- **Paraguay** (CONMEBOL)
- **Australia** (AFC)
- **euro-playoff-c** (playoff slot - user must select one of: Turkey, Romania, Slovakia, Kosovo)

### Group E
- **Germany** (UEFA)
- **Curaçao** (CONCACAF)
- **Ivory Coast** (CAF)
- **Ecuador** (CONMEBOL)

### Group F
- **Netherlands** (UEFA)
- **Japan** (AFC)
- **euro-playoff-b** (playoff slot - user must select one of: Ukraine, Sweden, Poland, Albania)
- **Tunisia** (CAF)

### Group G
- **Belgium** (UEFA)
- **Egypt** (CAF)
- **Iran** (AFC)
- **New Zealand** (OFC)

### Group H
- **Spain** (UEFA)
- **Cape Verde** (CAF)
- **Saudi Arabia** (AFC)
- **Uruguay** (CONMEBOL)

### Group I
- **France** (UEFA)
- **Senegal** (CAF)
- **intercon-playoff-2** (playoff slot - user must select one of: Bolivia, Suriname, Iraq)
- **Norway** (UEFA)

### Group J
- **Argentina** (CONMEBOL)
- **Algeria** (CAF)
- **Austria** (UEFA)
- **Jordan** (AFC)

### Group K
- **Portugal** (UEFA)
- **intercon-playoff-1** (playoff slot - user must select one of: Jamaica, New Caledonia, DR Congo)
- **Uzbekistan** (AFC)
- **Colombia** (CONMEBOL)

### Group L
- **England** (UEFA)
- **Croatia** (UEFA)
- **Ghana** (CAF)
- **Panama** (CONCACAF)

## Playoff Slots and Candidates

The following playoff slots must be resolved by the user before making group predictions:

### UEFA Playoff A
**Candidates:**
- Italy (UEFA)
- Northern Ireland (UEFA)
- Wales (UEFA)
- Bosnia & Herzegovina (UEFA)

**Used in:** Group B

### UEFA Playoff B
**Candidates:**
- Ukraine (UEFA)
- Sweden (UEFA)
- Poland (UEFA)
- Albania (UEFA)

**Used in:** Group F

### UEFA Playoff C
**Candidates:**
- Turkey (UEFA)
- Romania (UEFA)
- Slovakia (UEFA)
- Kosovo (UEFA)

**Used in:** Group D

### UEFA Playoff D
**Candidates:**
- Denmark (UEFA)
- North Macedonia (UEFA)
- Czechia (UEFA)
- Ireland (UEFA)

**Used in:** Group A

### Intercontinental Playoff 1
**Candidates:**
- Jamaica (CONCACAF)
- New Caledonia (OFC)
- DR Congo (CAF)

**Used in:** Group K

### Intercontinental Playoff 2
**Candidates:**
- Bolivia (CONMEBOL)
- Suriname (CONMEBOL)
- Iraq (AFC)

**Used in:** Group I

## Implementation Notes for Playoff Slots

1. **Initial State**: When displaying groups, show playoff slots as placeholders (e.g., "UEFA Playoff A" or "Select Playoff Winner")
2. **User Selection**: Allow users to click on a playoff slot to open a dialog/modal showing the candidate teams
3. **Selection**: Once a user selects a team for a playoff slot, replace the placeholder with the selected team
4. **Group Predictions**: After playoff selections are made, users can assign positions 1-4 to all teams in each group (including the selected playoff winners)
5. **Data Structure**: Store playoff selections separately from group predictions, or include them in the group structure by replacing the playoff slot ID with the selected team ID

**Example Data Structure:**
```typescript
// Before playoff selection
{ id: "A", teams: ["mexico", "south-africa", "south-korea", "euro-playoff-d"] }

// After user selects "denmark" for euro-playoff-d
{ id: "A", teams: ["mexico", "south-africa", "south-korea", "denmark"] }
```

## Design Guidelines

- **Color Scheme**: FIFA-inspired (deep blue, gold accents, white text)
- **Typography**: Clean, modern sans-serif
- **Spacing**: Generous padding and margins for readability
- **Responsive**: Works on desktop (primary) and tablet
- **Animations**: Smooth transitions for state changes
- **Accessibility**: Keyboard navigation, ARIA labels

## Testing Considerations

- Test constraint solver with various team combinations
- Test edge cases (all teams from same groups, etc.)
- Test zoom functionality at different zoom levels
- Test save/load functionality
- Test bracket resolution with partial predictions

## Deliverables

1. Complete React application with TypeScript
2. All UI components (GroupSelector, ThirdPlaceSelector, BracketView)
3. Constraint-satisfaction solver implementation
4. Bracket resolution logic
5. Zoom and pan functionality
6. Save/load functionality
7. Teams data
8. Bracket template definition
9. Styling with Tailwind CSS
10. README with setup instructions

## Bracket Navigation Flow

The bracket view uses a progressive navigation pattern that splits large rounds into left and right halves, allowing users to focus on one section at a time. This pattern continues until the semifinals, which are small enough to display both brackets simultaneously.

### Navigation Pattern

**For R32, R16, and QF (large rounds with left/right halves):**

1. **Start at Left Bracket (Top)**
   - Display matches from the left half of the bracket
   - Matches are shown in pairs, stacked vertically from top to bottom
   - Each pair shows two match cards on the left and the next round match card on the right (with connecting lines)
   - User selects winners for each match, progressing from top to bottom

2. **Continue to Left Bracket (Bottom)**
   - After completing all matches in the visible section, user continues scrolling/selecting through remaining left bracket matches
   - Pattern: top → bottom, working through all left bracket matches

3. **Continue Button → Right Bracket**
   - Once all left bracket matches have winners selected, a "Continue →" button appears
   - Clicking it switches to the right bracket view
   - The view resets to show right bracket matches starting from the top

4. **Right Bracket (Top → Bottom)**
   - Same pattern as left bracket: display matches from top to bottom
   - User selects winners for all right bracket matches

5. **Continue Button → Next Round**
   - Once both left and right brackets are complete, "Continue →" advances to the next round
   - The cycle repeats: start at left bracket (top), work through bottom, continue to right bracket, work through right bracket, continue to next round

**For Semifinals (SF):**
- **Special Layout**: Both brackets are displayed side by side simultaneously
- Final match is shown above the semifinals
- No left/right navigation needed - all matches visible at once
- This is the first round where the full bracket is shown together

**For Final (F):**
- Single match, centered display
- No navigation needed

### Bracket Half Logic

Matches are split into left and right halves based on their match IDs:

**R32 Split:**
- **Left**: M1, M3, M4, M6, M9-M12 (feeds into R16-M1, M2, M5, M6)
- **Right**: M2, M5, M7-M8, M13-M16 (feeds into R16-M3, M4, M7, M8)

**R16 Split:**
- **Left**: M1, M2, M5, M6 (feeds into QF-M1, M2 → SF-M1)
- **Right**: M3, M4, M7, M8 (feeds into QF-M3, M4 → SF-M2)

**QF Split:**
- **Left**: M1, M2 (feeds into SF-M1)
- **Right**: M3, M4 (feeds into SF-M2)

**SF:**
- **Left**: M1 (feeds into Final)
- **Right**: M2 (feeds into Final)
- Both displayed simultaneously

### Continue Button Logic

The "Continue →" button appears and behaves as follows:

```typescript
// For rounds with left/right halves (R32, R16, QF)
if (bracketHalf === "left" && leftComplete && rightMatches.length > 0) {
  // Show: "Continue →" to switch to right bracket
  onClick: () => setBracketHalf("right")
}

if (bracketHalf === "right" && leftComplete && rightComplete && nextRound) {
  // Show: "Continue →" to advance to next round
  onClick: () => setActiveRound(nextRound)
}

// For semifinals and final (no halves)
if (isComplete && nextRound) {
  // Show: "Continue →" to advance to next round
  onClick: () => setActiveRound(nextRound)
}
```

**Button States:**
- **Enabled**: When current section is complete and there's a valid next step
- **Disabled**: When current section is incomplete (grayed out but still visible)
- **Hidden**: When there's no next step (e.g., Final is complete)

### State Management

**Active Round:**
- Tracks which round is currently displayed (R32, R16, QF, SF, F)
- Starts at "R32" when bracket view loads

**Bracket Half:**
- Tracks which half is displayed ("left" or "right")
- Starts at "left" for each round
- Remembers last viewed half per round (if user navigates back)

**Scroll Behavior:**
- When bracket half or round changes, scroll to top
- Ensures user always starts at the top of the new section

### User Experience Flow

**Example: R32 → R16 → QF → SF → F**

1. **R32 Left Bracket**
   - View: R32 matches M1, M3, M4, M6, M9-M12 (top to bottom)
   - Select winners for all left bracket matches
   - Button: "Continue →" (switches to right bracket)

2. **R32 Right Bracket**
   - View: R32 matches M2, M5, M7-M8, M13-M16 (top to bottom)
   - Select winners for all right bracket matches
   - Button: "Continue →" (advances to R16)

3. **R16 Left Bracket**
   - View: R16 matches M1, M2, M5, M6 (top to bottom)
   - Select winners
   - Button: "Continue →" (switches to right bracket)

4. **R16 Right Bracket**
   - View: R16 matches M3, M4, M7, M8 (top to bottom)
   - Select winners
   - Button: "Continue →" (advances to QF)

5. **QF Left Bracket**
   - View: QF matches M1, M2 (top to bottom)
   - Select winners
   - Button: "Continue →" (switches to right bracket)

6. **QF Right Bracket**
   - View: QF matches M3, M4 (top to bottom)
   - Select winners
   - Button: "Continue →" (advances to SF)

7. **Semifinals**
   - View: Both SF-M1 and SF-M2 side by side, Final above
   - Select winners for both semifinals
   - Select final winner
   - Complete!

### Implementation Notes

- **Match Pairing**: Matches are displayed in pairs (match1, match2) vertically, with the next round match card appearing to the right (left bracket) or left (right bracket)
- **Completion Tracking**: Each bracket half tracks completion independently - both must be complete before advancing to next round
- **Visual Feedback**: Completed sections show progress indicators (e.g., "8/8" matches complete)
- **Back Navigation**: Users can navigate back to previous rounds using a "← Back" button, which restores the last viewed bracket half for that round

## Connecting Lines Between Match Cards

The bracket uses SVG paths to draw golden connecting lines that show how winners advance from one round to the next. This creates a traditional tournament bracket visualization.

### When Lines Are Rendered

Lines are only drawn when:
- Both matches in a pair have winners selected (`winner1` and `winner2` exist)
- The next match exists and is ready (both teams are known)
- All three matches are present (`match1`, `match2`, and `nextMatch`)

### Line Structure

Each pair of matches (e.g., R32-M1 and R32-M3) feeds into a single next match (e.g., R16-M1). Two lines are drawn:
1. **Line from match1 winner** → connects to the **home slot** of the next match
2. **Line from match2 winner** → connects to the **away slot** of the next match

### Position Calculations

**Match Card Dimensions:**
- Card height: `70px`
- Gap between cards: `8px` (gap-2 in Tailwind)
- Home button center within card: `22px` from card top
- Away button center within card: `37px` from card top

**Y-Position Calculation:**
```typescript
// Top position of each match card
const match1Top = 0;
const match2Top = cardHeight + cardGap; // 70 + 8 = 78px

// Winner Y position = card top + button center offset
const match1WinnerY = isWinner1Home 
  ? match1Top + homeButtonCenter  // 0 + 22 = 22px
  : match1Top + awayButtonCenter;  // 0 + 37 = 37px

const match2WinnerY = isWinner2Home
  ? match2Top + homeButtonCenter   // 78 + 22 = 100px
  : match2Top + awayButtonCenter;  // 78 + 37 = 115px

// Next match is centered vertically between the two matches
const nextMatchCenterY = (match1Top + match2Top + cardHeight) / 2;
const nextMatchHomeY = nextMatchCenterY - 7.5;  // Home slot (above center)
const nextMatchAwayY = nextMatchCenterY + 7.5;   // Away slot (below center)
```

### SVG Path Structure

Each line follows a three-segment path pattern:

**For left bracket (R32 on left, R16 on right):**
- **Match1 winner line**: 
  - Start: `(0, match1WinnerY)` - right edge of match1 card
  - Horizontal right: `(25, match1WinnerY)` - halfway point
  - Vertical down: `(25, nextMatchHomeY)` - center vertical line
  - Horizontal right: `(50, nextMatchHomeY)` - to next match home slot

- **Match2 winner line**:
  - Start: `(0, match2WinnerY)` - right edge of match2 card
  - Horizontal right: `(25, match2WinnerY)` - halfway point
  - Vertical up: `(25, nextMatchAwayY)` - center vertical line
  - Horizontal right: `(50, nextMatchAwayY)` - to next match away slot

**For right bracket (R32 on right, R16 on left):**
- Same pattern but reversed horizontally (start at `50`, end at `0`)

### Implementation

```typescript
// Container for lines (positioned between match cards and next match)
<div className="relative" style={{ 
  width: '50px', 
  height: `${match2Top + cardHeight}px` 
}}>
  <svg 
    className="absolute inset-0 w-full h-full" 
    style={{ pointerEvents: 'none', overflow: 'visible' }}
  >
    {/* Line from match1 winner */}
    <path
      d={`M ${isLeftBracket ? '0' : '50'},${match1WinnerY} 
          L ${isLeftBracket ? '25' : '25'},${match1WinnerY} 
          L ${isLeftBracket ? '25' : '25'},${nextMatchHomeY} 
          L ${isLeftBracket ? '50' : '0'},${nextMatchHomeY}`}
      stroke="rgba(212, 169, 23, 0.5)"
      strokeWidth="2"
      fill="none"
    />
    {/* Line from match2 winner */}
    <path
      d={`M ${isLeftBracket ? '0' : '50'},${match2WinnerY} 
          L ${isLeftBracket ? '25' : '25'},${match2WinnerY} 
          L ${isLeftBracket ? '25' : '25'},${nextMatchAwayY} 
          L ${isLeftBracket ? '50' : '0'},${nextMatchAwayY}`}
      stroke="rgba(212, 169, 23, 0.5)"
      strokeWidth="2"
      fill="none"
    />
  </svg>
</div>
```

### Styling

- **Color**: `rgba(212, 169, 23, 0.5)` - golden/yellow with 50% opacity
- **Stroke width**: `2px`
- **Fill**: `none` (outline only)
- **Pointer events**: `none` (lines don't interfere with clicks)
- **Overflow**: `visible` (lines can extend beyond container if needed)

### Key Points

1. **Conditional rendering**: Lines only appear when both winners are selected
2. **Dynamic positioning**: Y-positions adjust based on which team won (home vs away)
3. **Bracket direction**: Line direction flips for left vs right bracket halves
4. **Centered next match**: The next match card is vertically centered between the two source matches
5. **Three-segment paths**: Horizontal → vertical → horizontal creates the classic bracket look
6. **SVG container**: Lines are in a separate positioned container between match columns

## Notes

- The constraint solver is the most critical component - ensure it correctly assigns teams to slots
- The full bracket view should be visually clear and easy to navigate even when zoomed out
- Zoom should feel smooth and responsive
- Match connections should be visually clear (lines or paths showing advancement)
- The app should handle the initial state gracefully (no predictions yet)

---

**Start by setting up the project structure, then implement the data models, then the constraint solver, then the UI components, and finally integrate everything together.**




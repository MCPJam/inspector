import type { PlayerRecord } from './types.js';
import { SquadStore } from './SquadStore.js';

// Category types that can appear on the axes
// Note: "Shirt Number" is optional and may appear on either axis but is not required
export type CategoryType = 'Country' | 'Position' | 'League' | 'Team' | 'Shirt Number';
export type CellMark = 'O' | 'X' | null; // O = user (circle), X = AI

export interface GameCell {
  player: PlayerRecord | null;
  category: CategoryType | null;
  mark: CellMark; // Who placed a mark here (O or X)
}

export interface Game {
  id: string;
  grid: GameCell[][];
  rowCategories: string[]; // Category values for rows (e.g., ["Liverpool", "Forward", "Chelsea"])
  columnCategories: string[]; // Category values for columns (e.g., ["England", "Napoli", "Atletico Madrid"])
  rowCategoryTypes: CategoryType[]; // Category types for rows
  columnCategoryTypes: CategoryType[]; // Category types for columns
  currentTurn: 'user' | 'ai';
  winner: 'user' | 'ai' | 'draw' | null;
  isComplete: boolean;
  size: number; // 4 for 4x4 grid
  difficulty: 'easy' | 'medium' | 'hard'; // Current difficulty level
  previousDifficulty?: 'easy' | 'medium' | 'hard'; // Previous difficulty (for transitions)
  progressToNextLevel?: number; // Progress percentage (0-100) toward next difficulty level
  createdAt: Date;
}

/**
 * Game Engine - Tic-tac-toe with soccer players
 * User plays O's (circles), AI plays X's
 */
export class GameEngine {
  private squadStore: SquadStore;
  // Shuffled player pools by priority level - reshuffled when exhausted
  private shuffledPriority1Players: PlayerRecord[] = [];
  private shuffledPriority2Players: PlayerRecord[] = [];
  private shuffledPriority3Players: PlayerRecord[] = [];
  private shuffledAllPlayers: PlayerRecord[] = [];
  // Current indices in shuffled arrays
  private priority1Index: number = 0;
  private priority2Index: number = 0;
  private priority3Index: number = 0;
  private allPlayersIndex: number = 0;
  private currentDifficulty: 'easy' | 'medium' | 'hard' = 'easy'; // Track difficulty across games - progresses after 5 wins
  private lastGameDifficulty: 'easy' | 'medium' | 'hard' | null = null; // Track last game's difficulty for transitions
  private lastGameWinner: 'user' | 'ai' | 'draw' | null = null; // Track last game result to reset players on loss
  private gamesWonAtCurrentDifficulty: number = 0; // Track wins at current difficulty (5 wins = progress)

  constructor(squadStore: SquadStore) {
    this.squadStore = squadStore;
    this.initializeShuffledPlayers();
  }

  /**
   * Initialize shuffled player pools by priority level
   */
  private initializeShuffledPlayers(): void {
    const allPlayers = this.squadStore.getAll();
    this.shuffledPriority1Players = this.shuffle(allPlayers.filter(p => this.getPlayerPriority(p) === 1));
    this.shuffledPriority2Players = this.shuffle(allPlayers.filter(p => this.getPlayerPriority(p) === 2));
    this.shuffledPriority3Players = this.shuffle(allPlayers.filter(p => this.getPlayerPriority(p) === 3));
    this.shuffledAllPlayers = this.shuffle([...allPlayers]);
    this.priority1Index = 0;
    this.priority2Index = 0;
    this.priority3Index = 0;
    this.allPlayersIndex = 0;
  }

  /**
   * Get next player from shuffled pool by priority, reshuffling if exhausted
   */
  private getNextShuffledPlayer(priority: 1 | 2 | 3 | null = null): PlayerRecord | null {
    if (priority === 1) {
      if (this.priority1Index >= this.shuffledPriority1Players.length) {
        // Reshuffle when exhausted
        this.shuffledPriority1Players = this.shuffle([...this.shuffledPriority1Players]);
        this.priority1Index = 0;
      }
      return this.shuffledPriority1Players[this.priority1Index++];
    } else if (priority === 2) {
      if (this.priority2Index >= this.shuffledPriority2Players.length) {
        this.shuffledPriority2Players = this.shuffle([...this.shuffledPriority2Players]);
        this.priority2Index = 0;
      }
      return this.shuffledPriority2Players[this.priority2Index++];
    } else if (priority === 3) {
      if (this.priority3Index >= this.shuffledPriority3Players.length) {
        this.shuffledPriority3Players = this.shuffle([...this.shuffledPriority3Players]);
        this.priority3Index = 0;
      }
      return this.shuffledPriority3Players[this.priority3Index++];
    } else {
      // All players
      if (this.allPlayersIndex >= this.shuffledAllPlayers.length) {
        this.shuffledAllPlayers = this.shuffle([...this.shuffledAllPlayers]);
        this.allPlayersIndex = 0;
      }
      return this.shuffledAllPlayers[this.allPlayersIndex++];
    }
  }

  /**
   * Get player priority value for difficulty levels
   * Returns 1 (easy/famous), 2 (medium), 3 (hard/less famous), or 0 (no priority)
   */
  private getPlayerPriority(player: PlayerRecord): number {
    const priority = player.Priority;
    if (!priority) return 0;
    
    // Handle string or number
    const num = typeof priority === 'string' ? parseInt(priority, 10) : priority;
    return isNaN(num) ? 0 : Math.max(0, Math.min(3, num)); // Clamp between 0-3
  }

  /**
   * Count how many players match a specific category value
   * Returns the count of players that match this category value
   */
  private countCategoryMatches(categoryType: CategoryType, categoryValue: string): number {
    const allPlayers = this.squadStore.getAll();
    return allPlayers.filter(player => {
      const playerValue = this.getCategoryValue(player, categoryType);
      return playerValue === categoryValue;
    }).length;
  }

  /**
   * Get category difficulty based on match availability
   * Returns: 1 = Easy (5+ matches), 2 = Medium (3-4 matches), 3 = Hard (1-2 matches)
   */
  private getCategoryDifficulty(categoryType: CategoryType, categoryValue: string): number {
    const matchCount = this.countCategoryMatches(categoryType, categoryValue);
    if (matchCount >= 5) return 1; // Easy - many matches available
    if (matchCount >= 3) return 2; // Medium - moderate matches
    return 3; // Hard - few matches available
  }

  /**
   * Check if a category value has an image available (based on widget image mappings)
   */
  private hasCategoryImage(categoryType: CategoryType, categoryValue: string): boolean {
    if (categoryType === 'Position') {
      // All positions have images (Goalkeeper.webp or Soccer_Player.png)
      return true;
    }
    
    if (categoryType === 'Shirt Number') {
      // Shirt numbers always have Shirt_Number.png
      return true;
    }
    
    if (categoryType === 'Team') {
      // Only teams with logos
      const teamsWithImages = [
        'FC Barcelona',
        'Real Madrid',
        'Atletico Madrid',
        'Manchester City',
        'Manchester United',
        'Chelsea',
        'Liverpool',
        'Arsenal',
        'Tottenham Hotspur',
        'Bayern Munich'
      ];
      return teamsWithImages.includes(categoryValue);
    }
    
    if (categoryType === 'Country') {
      // Only countries with flag images
      const countriesWithImages = [
        'ESP', 'ENG', 'GER', 'FRA', 'ITA', 'BRA', 'ARG', 'POR', 'BEL', 'NED',
        'NOR', 'SWE', 'URU', 'POL', 'DEN', 'USA', 'SVN', 'SVK', 'KOR', 'UZB'
      ];
      return countriesWithImages.includes(categoryValue);
    }
    
    if (categoryType === 'League') {
      // Only leagues with logos
      const leaguesWithImages = ['LaLiga', 'Premier League', 'Bayern'];
      return leaguesWithImages.includes(categoryValue);
    }
    
    return false;
  }

  /**
   * Get all unique values for a category type, sorted by match availability (easy first)
   * Only returns categories that have images available
   */
  private getCategoryValuesByDifficulty(categoryType: CategoryType): Array<{ value: string; difficulty: number; matchCount: number }> {
    const allPlayers = this.squadStore.getAll();
    const valueMap = new Map<string, number>();

    // Count matches for each category value
    for (const player of allPlayers) {
      const value = this.getCategoryValue(player, categoryType);
      if (value && this.hasCategoryImage(categoryType, value)) {
        valueMap.set(value, (valueMap.get(value) || 0) + 1);
      }
    }

    // Convert to array with difficulty scores
    const result = Array.from(valueMap.entries())
      .map(([value, matchCount]) => ({
        value,
        difficulty: this.getCategoryDifficulty(categoryType, value),
        matchCount,
      }))
      .sort((a, b) => {
        // Sort by difficulty (1=easy first), then by match count
        if (a.difficulty !== b.difficulty) {
          return a.difficulty - b.difficulty;
        }
        return b.matchCount - a.matchCount;
      });

    // Filter out "Bundesliga" from League categories - we only use Bayern Munich as a Team category
    if (categoryType === 'League') {
      return result.filter(item => item.value !== 'Bundesliga');
    }

    return result;
  }

  /**
   * Get a unique identifier for a player (Name + Team for uniqueness)
   */
  private getPlayerId(player: PlayerRecord): string {
    return `${player.Name}|${player.Team}`;
  }

  /**
   * Reset shuffled players (called when user loses a game or difficulty changes)
   */
  private resetRecentPlayers(): void {
    // Reshuffle all player pools to start fresh
    this.initializeShuffledPlayers();
    // Don't reset used players sets - we track across games for progress
  }

  // Removed combination tracking - we now use shuffled pools instead

  /**
   * Get next matching player from shuffled pool
   * Returns the first player from the shuffled pool that matches the criteria
   */
  private getNextMatchingPlayerFromShuffled(
    matchingPlayers: PlayerRecord[],
    priority: 1 | 2 | 3 | null,
    difficulty: 'easy' | 'medium' | 'hard'
  ): PlayerRecord | null {
    // Create a set of matching player IDs for fast lookup
    const matchingPlayerIds = new Set(matchingPlayers.map(p => this.getPlayerId(p)));
    
    // Determine which shuffled pool to use based on priority
    let shuffledPool: PlayerRecord[] = [];
    let poolIndexRef: { value: number } = { value: 0 };
    
    if (priority === 1) {
      shuffledPool = this.shuffledPriority1Players;
      poolIndexRef = { value: this.priority1Index };
    } else if (priority === 2) {
      shuffledPool = this.shuffledPriority2Players;
      poolIndexRef = { value: this.priority2Index };
    } else if (priority === 3) {
      shuffledPool = this.shuffledPriority3Players;
      poolIndexRef = { value: this.priority3Index };
    } else {
      shuffledPool = this.shuffledAllPlayers;
      poolIndexRef = { value: this.allPlayersIndex };
    }
    
    // Search from current index forward, wrapping around if needed
    const startIndex = poolIndexRef.value;
    let attempts = 0;
    const maxAttempts = shuffledPool.length;
    
    while (attempts < maxAttempts) {
      const currentIndex = (startIndex + attempts) % shuffledPool.length;
      const player = shuffledPool[currentIndex];
      
      if (matchingPlayerIds.has(this.getPlayerId(player))) {
        // Found a match - update the index for next time
        const nextIndex = (currentIndex + 1) % shuffledPool.length;
        if (priority === 1) {
          this.priority1Index = nextIndex;
        } else if (priority === 2) {
          this.priority2Index = nextIndex;
        } else if (priority === 3) {
          this.priority3Index = nextIndex;
      } else {
          this.allPlayersIndex = nextIndex;
        }
        return player;
      }
      
      attempts++;
    }
    
    // No match found in shuffled pool - return null (caller will handle fallback)
    return null;
  }

  // Removed getCurrentDifficulty - each game is independent, always starts at easy

  /**
   * Calculate progress toward next difficulty level (0-100)
   * Based on games won - 5 wins per difficulty level
   */
  private calculateProgressToNextLevel(): number {
    if (this.currentDifficulty === 'easy' || this.currentDifficulty === 'medium') {
      // 5 wins per level = 20% per win
      const progress = Math.min(100, (this.gamesWonAtCurrentDifficulty / 5) * 100);
      const rounded = Math.round(progress);
      console.log(`GameEngine: calculateProgressToNextLevel - gamesWon=${this.gamesWonAtCurrentDifficulty}, difficulty=${this.currentDifficulty}, progress=${rounded}%`);
      return rounded;
    }
    
    return 100; // Hard is max, always at 100%
  }

  /**
   * Check if we should progress to next difficulty level
   * Progresses when: user wins 5 games at current difficulty
   */
  private shouldProgressDifficulty(): boolean {
    if (this.lastGameWinner !== 'user') {
      return false; // Only progress on user wins
    }

    // Progress after 5 wins at current difficulty
    return this.gamesWonAtCurrentDifficulty >= 5;
  }

  /**
   * Progress to next difficulty level
   */
  private progressDifficulty(): void {
    if (this.currentDifficulty === 'easy') {
      this.currentDifficulty = 'medium';
    } else if (this.currentDifficulty === 'medium') {
      this.currentDifficulty = 'hard';
    }
    // Hard is max, no further progression
  }

  /**
   * Reset difficulty to easy (for when user exits after losing)
   */
  resetDifficulty(): void {
    this.currentDifficulty = 'easy';
    this.lastGameDifficulty = null;
    this.lastGameWinner = null;
    this.gamesWonAtCurrentDifficulty = 0;
    // Reset indices to start fresh
    this.priority1Index = 0;
    this.priority2Index = 0;
    this.priority3Index = 0;
    this.resetRecentPlayers();
  }

  /**
   * Get current difficulty state (for persistence)
   */
  getDifficultyState(): {
    currentDifficulty: 'easy' | 'medium' | 'hard';
    gamesWonAtCurrentDifficulty: number;
    lastGameWinner: 'user' | 'ai' | 'draw' | null;
  } {
    return {
      currentDifficulty: this.currentDifficulty,
      gamesWonAtCurrentDifficulty: this.gamesWonAtCurrentDifficulty,
      lastGameWinner: this.lastGameWinner,
    };
  }

  /**
   * Restore difficulty state (from persistence)
   */
  restoreDifficultyState(state: {
    currentDifficulty: 'easy' | 'medium' | 'hard';
    gamesWonAtCurrentDifficulty: number;
    lastGameWinner: 'user' | 'ai' | 'draw' | null;
  }): void {
    console.log('GameEngine: Restoring difficulty state:', state);
    this.currentDifficulty = state.currentDifficulty;
    this.gamesWonAtCurrentDifficulty = state.gamesWonAtCurrentDifficulty;
    this.lastGameWinner = state.lastGameWinner;
    console.log('GameEngine: After restore, gamesWonAtCurrentDifficulty =', this.gamesWonAtCurrentDifficulty);
  }

  /**
   * Generate a new 4x4 tic-tac-toe game
   * Difficulty progresses based on wins: Easy -> Medium -> Hard
   * @param difficulty - Optional override (defaults to current difficulty)
   *   - Easy: At least 3 players with Priority 1 (famous) - STRICT: only Priority 1 allowed
   *   - Medium: At least 2 players with Priority 1 + at least 1 with Priority 2
   *   - Hard: At least 1 player from each priority tier (P1, P2, P3) and total ≥ 6
   */
  generateGame(difficulty?: 'easy' | 'medium' | 'hard', forceReset?: boolean): Game {
    // Always reshuffle when creating a new game for fresh randomization
      this.resetRecentPlayers();
    
    // Reset difficulty and recent players ONLY if explicitly requested
    // Don't reset based on lastGameWinner here - that's handled when the game completes
    // The saved progress already has the correct state (reset on loss, preserved on win)
    if (forceReset) {
      // Reset difficulty to easy on explicit request (e.g., user exits after losing)
      this.currentDifficulty = 'easy';
      this.lastGameDifficulty = null;
      this.lastGameWinner = null; // Clear after resetting
      this.gamesWonAtCurrentDifficulty = 0; // Reset win counter
      // Reset indices to start fresh
      this.priority1Index = 0;
      this.priority2Index = 0;
      this.priority3Index = 0;
    }
    
    // Track previous difficulty BEFORE any progression happens
    const previousDifficultyBeforeProgression = this.currentDifficulty;
    
    // Check if we should progress difficulty after last win
    if (this.shouldProgressDifficulty()) {
      this.progressDifficulty();
      // Reset win counter after progressing
      this.gamesWonAtCurrentDifficulty = 0;
    }
    
    // Use specified difficulty or current difficulty
    // If no difficulty specified and this is first game, start at 'easy'
    let gameDifficulty = difficulty || this.currentDifficulty || 'easy';
    
    // Check if we've run out of Priority 1 players in easy mode - auto-progress to medium
    if (gameDifficulty === 'easy') {
      const allPlayers = this.squadStore.getAll();
      const priority1Players = allPlayers.filter(p => this.getPlayerPriority(p) === 1);
      // With shuffled pools, all players are available (they're just in shuffled order)
      const availablePriority1 = priority1Players;
      if (availablePriority1.length < 3) {
        // Not enough Priority 1 players - auto-progress to medium
        console.log('Easy mode: Not enough Priority 1 players available, auto-progressing to medium');
        gameDifficulty = 'medium';
        this.currentDifficulty = 'medium';
        // Already shuffled at the start of generateGame, no need to reshuffle again
      }
    }
    
    // Track previous difficulty for transitions (only if it changed)
    // Use the difficulty before progression if it changed, otherwise use lastGameDifficulty
    const previousDifficulty = (previousDifficultyBeforeProgression && previousDifficultyBeforeProgression !== gameDifficulty)
      ? previousDifficultyBeforeProgression
      : (this.lastGameDifficulty && this.lastGameDifficulty !== gameDifficulty 
        ? this.lastGameDifficulty 
        : undefined);
    this.lastGameDifficulty = gameDifficulty;
    const allPlayers = this.squadStore.getAll();
    if (allPlayers.length < 9) {
      throw new Error('Not enough players. Need at least 9 players.');
    }

    // Find category values that work together (each combination has at least one match)
    // Strategy: Start with easy category values, then verify all combinations have matches
    let attempts = 0;
    const maxAttempts = 200; // Try to find valid category combinations
    let foundValidCombination = false;
    let rowCategoryValues: string[] = [];
    let columnCategoryValues: string[] = [];
    let finalRowCategoryTypes: CategoryType[] = [];
    let finalColumnCategoryTypes: CategoryType[] = [];

    while (attempts < maxAttempts && !foundValidCombination) {
      // Select 3 category types for rows and 3 for columns (randomize each attempt)
      // Rows and columns can have repeated types within themselves,
      // but the SET of row types and SET of column types must be disjoint
      const categoryTypes: CategoryType[] = ['Country', 'Position', 'League', 'Team', 'Shirt Number'];
      const shuffledTypes = this.shuffle([...categoryTypes]);
      
      // Split types into two groups to ensure no overlap between rows and columns
      // Also ensure Team and League are not in opposite dimensions
      const splitPoint = Math.floor(Math.random() * 3) + 1; // 1, 2, or 3
      let rowTypePool = shuffledTypes.slice(0, splitPoint);
      let columnTypePool = shuffledTypes.slice(splitPoint);
      
      // Ensure both pools have at least one type
      if (rowTypePool.length === 0 || columnTypePool.length === 0) {
        rowTypePool = shuffledTypes.slice(0, 2);
        columnTypePool = shuffledTypes.slice(2);
      }
      
      // Early check: if Team and League are in opposite pools, reshuffle
      const rowHasTeam = rowTypePool.includes('Team');
      const columnHasLeague = columnTypePool.includes('League');
      const rowHasLeague = rowTypePool.includes('League');
      const columnHasTeam = columnTypePool.includes('Team');
      
      if ((rowHasTeam && columnHasLeague) || (rowHasLeague && columnHasTeam)) {
        attempts++;
        continue; // Try again - Team and League cannot be in opposite dimensions
      }
      
      // Select 3 types for rows - ensure variety: don't use the same type for all 3 rows
      const rowCategoryTypes: CategoryType[] = [];
      const availableRowTypes = [...rowTypePool];
      for (let i = 0; i < 3; i++) {
        if (availableRowTypes.length === 0) {
          // If we've used all types, allow repeats
          rowCategoryTypes.push(rowTypePool[Math.floor(Math.random() * rowTypePool.length)]);
        } else {
          // Prefer using a type we haven't used yet in this row set
          const randomIndex = Math.floor(Math.random() * availableRowTypes.length);
          rowCategoryTypes.push(availableRowTypes.splice(randomIndex, 1)[0]);
        }
      }
      
      // Select 3 types for columns - ensure variety: don't use the same type for all 3 columns
      const columnCategoryTypes: CategoryType[] = [];
      const availableColumnTypes = [...columnTypePool];
      for (let i = 0; i < 3; i++) {
        if (availableColumnTypes.length === 0) {
          // If we've used all types, allow repeats
          columnCategoryTypes.push(columnTypePool[Math.floor(Math.random() * columnTypePool.length)]);
        } else {
          // Prefer using a type we haven't used yet in this column set
          const randomIndex = Math.floor(Math.random() * availableColumnTypes.length);
          columnCategoryTypes.push(availableColumnTypes.splice(randomIndex, 1)[0]);
        }
      }
      
      // Verify constraint: sets of row types and column types must be disjoint
      const rowTypeSet = new Set(rowCategoryTypes);
      const columnTypeSet = new Set(columnCategoryTypes);
      const hasOverlap = Array.from(rowTypeSet).some(type => columnTypeSet.has(type));
      if (hasOverlap) {
        attempts++;
        continue; // Try again with different type selection
      }
      
      // Additional constraint: Team and League cannot be in opposite dimensions
      // If rows have Team, columns cannot have League (and vice versa)
      const rowsHaveTeam = rowTypeSet.has('Team');
      const columnsHaveLeague = columnTypeSet.has('League');
      const rowsHaveLeague = rowTypeSet.has('League');
      const columnsHaveTeam = columnTypeSet.has('Team');
      
      if ((rowsHaveTeam && columnsHaveLeague) || (rowsHaveLeague && columnsHaveTeam)) {
        attempts++;
        continue; // Try again - Team and League cannot be in opposite dimensions
      }
      // Get candidate values for rows (prioritize easy)
      const rowCandidates: string[][] = [];
      for (const catType of rowCategoryTypes) {
        const valuesByDifficulty = this.getCategoryValuesByDifficulty(catType);
        const easyValues = valuesByDifficulty.filter(v => v.difficulty === 1);
        const candidates = easyValues.length > 0 
          ? easyValues.slice(0, 10).map(v => v.value)
          : valuesByDifficulty.slice(0, 10).map(v => v.value);
        rowCandidates.push(candidates);
      }

      // Get candidate values for columns
      const columnCandidates: string[][] = [];
      for (const catType of columnCategoryTypes) {
        const valuesByDifficulty = this.getCategoryValuesByDifficulty(catType);
        const easyValues = valuesByDifficulty.filter(v => v.difficulty === 1);
        const candidates = easyValues.length > 0 
          ? easyValues.slice(0, 10).map(v => v.value)
          : valuesByDifficulty.slice(0, 10).map(v => v.value);
        columnCandidates.push(candidates);
      }

      // Try random combinations
      const testRowValues = rowCandidates.map(candidates => 
        this.shuffle([...candidates])[0]
      );
      const testColumnValues = columnCandidates.map(candidates => 
        this.shuffle([...candidates])[0]
      );

      // Verify no duplicate values anywhere (prevent any redundancy)
      // Check all values across rows and columns - no duplicates allowed
      const allValues = [...testRowValues, ...testColumnValues];
      const uniqueValues = new Set(allValues);
      let allCombinationsValid = allValues.length === uniqueValues.size; // No duplicates
      
      // Also verify no duplicate values within rows (prevent any duplicates, regardless of type)
      if (allCombinationsValid) {
        const rowValueSet = new Set(testRowValues);
        if (rowValueSet.size !== testRowValues.length) {
          allCombinationsValid = false;
        }
      }
      
      // Verify no duplicate values within columns (prevent any duplicates, regardless of type)
      if (allCombinationsValid) {
        const colValueSet = new Set(testColumnValues);
        if (colValueSet.size !== testColumnValues.length) {
          allCombinationsValid = false;
        }
      }

      // Verify all combinations have at least one match AND no trivial matches
      if (allCombinationsValid) {
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) {
            const rowValue = testRowValues[row];
            const colValue = testColumnValues[col];
            const rowType = rowCategoryTypes[row];
            const colType = columnCategoryTypes[col];

            // Prevent trivial matches: same type AND same value (e.g., "Argentina" row AND "Argentina" column)
            if (rowType === colType && rowValue === colValue) {
              allCombinationsValid = false;
              break;
            }

            const matches = allPlayers.filter(p => {
              const playerRowValue = this.getCategoryValue(p, rowType);
              const playerColValue = this.getCategoryValue(p, colType);
              return playerRowValue === rowValue && playerColValue === colValue;
            });

            // Check if matches meet difficulty requirements
            if (matches.length === 0) {
              allCombinationsValid = false;
              break;
            }
            
            // For Easy mode: must have at least one Priority 1 player
            if (gameDifficulty === 'easy') {
              const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
              if (priority1Matches.length === 0) {
                allCombinationsValid = false;
                break;
              }
            }
            // For Medium mode: must have enough Priority 1 and Priority 2 players
            else if (gameDifficulty === 'medium') {
              const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
              const priority2Matches = matches.filter(p => this.getPlayerPriority(p) === 2);
              // Need at least 5 Priority 1 and 4 Priority 2 total in the game, but for validation
              // we just need to ensure this combination can contribute (has at least 1 Priority 1 or 2)
              if (priority1Matches.length === 0 && priority2Matches.length === 0) {
                allCombinationsValid = false;
                break;
              }
            }
            // For Hard mode: must have at least one Priority 1, 2, or 3 player (should always be true)
            // but we validate to ensure we can meet the minimum requirements
            else if (gameDifficulty === 'hard') {
              const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
              const priority2Matches = matches.filter(p => this.getPlayerPriority(p) === 2);
              const priority3Matches = matches.filter(p => this.getPlayerPriority(p) === 3);
              // Need at least 3 of each priority total, but for validation we just check availability
              if (priority1Matches.length === 0 && priority2Matches.length === 0 && priority3Matches.length === 0) {
                allCombinationsValid = false;
                break;
              }
            }
          }
          if (!allCombinationsValid) break;
        }
      }

      if (allCombinationsValid) {
        // Found a valid combination!
        rowCategoryValues = testRowValues;
        columnCategoryValues = testColumnValues;
        finalRowCategoryTypes = rowCategoryTypes;
        finalColumnCategoryTypes = columnCategoryTypes;
        foundValidCombination = true;
        break;
      }

      attempts++;
    }

    // If we couldn't find a valid combination after many tries, try fallback
    if (!foundValidCombination && attempts >= maxAttempts * 0.8) {
      // Try one more time with simpler selection
      for (let retry = 0; retry < 50; retry++) {
        const categoryTypes: CategoryType[] = ['Country', 'Position', 'League', 'Team', 'Shirt Number'];
        const shuffledTypes = this.shuffle([...categoryTypes]);
        const splitPoint = Math.floor(Math.random() * 3) + 1;
        let rowTypePool = shuffledTypes.slice(0, splitPoint);
        let columnTypePool = shuffledTypes.slice(splitPoint);
        
        if (rowTypePool.length === 0 || columnTypePool.length === 0) {
          rowTypePool = shuffledTypes.slice(0, 2);
          columnTypePool = shuffledTypes.slice(2);
        }
        
        const rowCategoryTypes: CategoryType[] = [];
        for (let i = 0; i < 3; i++) {
          rowCategoryTypes.push(rowTypePool[Math.floor(Math.random() * rowTypePool.length)]);
        }
        
        const columnCategoryTypes: CategoryType[] = [];
        for (let i = 0; i < 3; i++) {
          columnCategoryTypes.push(columnTypePool[Math.floor(Math.random() * columnTypePool.length)]);
        }
        
        const rowTypeSet = new Set(rowCategoryTypes);
        const columnTypeSet = new Set(columnCategoryTypes);
        if (Array.from(rowTypeSet).some(type => columnTypeSet.has(type))) {
          continue;
        }
        
        // Additional constraint: Team and League cannot be in opposite dimensions
        const rowsHaveTeam = rowTypeSet.has('Team');
        const columnsHaveLeague = columnTypeSet.has('League');
        const rowsHaveLeague = rowTypeSet.has('League');
        const columnsHaveTeam = columnTypeSet.has('Team');
        
        if ((rowsHaveTeam && columnsHaveLeague) || (rowsHaveLeague && columnsHaveTeam)) {
          continue; // Try again - Team and League cannot be in opposite dimensions
        }
        
        const rowCandidates: string[][] = [];
        for (const catType of rowCategoryTypes) {
          const valuesByDifficulty = this.getCategoryValuesByDifficulty(catType);
          const candidates = valuesByDifficulty.slice(0, 10).map(v => v.value);
          rowCandidates.push(candidates);
        }
        
        const columnCandidates: string[][] = [];
        for (const catType of columnCategoryTypes) {
          const valuesByDifficulty = this.getCategoryValuesByDifficulty(catType);
          const candidates = valuesByDifficulty.slice(0, 10).map(v => v.value);
          columnCandidates.push(candidates);
        }
        
        const testRowValues = rowCandidates.map(candidates => 
          this.shuffle([...candidates])[0]
        );
        const testColumnValues = columnCandidates.map(candidates => 
          this.shuffle([...candidates])[0]
        );
        
        // Verify no duplicate values anywhere (prevent any redundancy)
        // Check all values across rows and columns - no duplicates allowed
        const allValues = [...testRowValues, ...testColumnValues];
        const uniqueValues = new Set(allValues);
        let allValid = allValues.length === uniqueValues.size; // No duplicates
        
        // Also verify no duplicate values within rows (prevent any duplicates, regardless of type)
        if (allValid) {
          const rowValueSet = new Set(testRowValues);
          if (rowValueSet.size !== testRowValues.length) {
            allValid = false;
          }
        }
        
        // Verify no duplicate values within columns (prevent any duplicates, regardless of type)
        if (allValid) {
          const colValueSet = new Set(testColumnValues);
          if (colValueSet.size !== testColumnValues.length) {
            allValid = false;
          }
        }
        
        // Verify all combinations have at least one match AND no trivial matches
        if (allValid) {
          for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
              const rowValue = testRowValues[row];
              const colValue = testColumnValues[col];
              const rowType = rowCategoryTypes[row];
              const colType = columnCategoryTypes[col];

              // Prevent trivial matches: same type AND same value (e.g., "Argentina" row AND "Argentina" column)
              if (rowType === colType && rowValue === colValue) {
                allValid = false;
                break;
              }

              const matches = allPlayers.filter(p => {
                const playerRowValue = this.getCategoryValue(p, rowType);
                const playerColValue = this.getCategoryValue(p, colType);
                return playerRowValue === rowValue && playerColValue === colValue;
              });
              if (matches.length === 0) {
                allValid = false;
                break;
              }
              
              // Check if matches meet difficulty requirements
              // For Easy mode: must have at least one Priority 1 player
              if (gameDifficulty === 'easy') {
                const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
                if (priority1Matches.length === 0) {
                  allValid = false;
                  break;
                }
              }
              // For Medium mode: must have at least one Priority 1 or 2 player
              else if (gameDifficulty === 'medium') {
                const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
                const priority2Matches = matches.filter(p => this.getPlayerPriority(p) === 2);
                if (priority1Matches.length === 0 && priority2Matches.length === 0) {
                  allValid = false;
                  break;
                }
              }
              // For Hard mode: must have at least one Priority 1, 2, or 3 player
              else if (gameDifficulty === 'hard') {
                const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
                const priority2Matches = matches.filter(p => this.getPlayerPriority(p) === 2);
                const priority3Matches = matches.filter(p => this.getPlayerPriority(p) === 3);
                if (priority1Matches.length === 0 && priority2Matches.length === 0 && priority3Matches.length === 0) {
                  allValid = false;
                  break;
                }
              }
            }
            if (!allValid) break;
          }
        }
        
        if (allValid) {
          rowCategoryValues = testRowValues;
          columnCategoryValues = testColumnValues;
          finalRowCategoryTypes = rowCategoryTypes;
          finalColumnCategoryTypes = columnCategoryTypes;
          foundValidCombination = true;
          break;
        }
      }
    }

    // If we still couldn't find a combination, use fallback (don't auto-progress difficulty)
    // Each game is independent - if we can't find valid combinations, use fallback values
    if (!foundValidCombination && attempts >= maxAttempts) {
      // Reset to use the last attempted combination
      if (finalRowCategoryTypes.length === 0) {
        // Fallback: regenerate types one more time
        const categoryTypes: CategoryType[] = ['Country', 'Position', 'League', 'Team', 'Shirt Number'];
        const shuffledTypes = this.shuffle([...categoryTypes]);
        const splitPoint = Math.floor(Math.random() * 3) + 1;
        const rowTypePool = shuffledTypes.slice(0, splitPoint);
        const columnTypePool = shuffledTypes.slice(splitPoint);
        finalRowCategoryTypes = [rowTypePool[0], rowTypePool[0] || rowTypePool[1] || 'Country', rowTypePool[1] || rowTypePool[0] || 'Country'];
        finalColumnCategoryTypes = [columnTypePool[0], columnTypePool[0] || columnTypePool[1] || 'Position', columnTypePool[1] || columnTypePool[0] || 'Position'];
      }
    }

    // Use the found combination types
    let rowCategoryTypes: CategoryType[] = finalRowCategoryTypes.length > 0
      ? finalRowCategoryTypes
      : ['Country', 'Position', 'Position']; // Default: rows focus on Country + Position

    let columnCategoryTypes: CategoryType[] = finalColumnCategoryTypes.length > 0
      ? finalColumnCategoryTypes
      : ['League', 'Team', 'Team']; // Default: columns focus on League + Team

    // Hard rule for UX:
    // - Each of Country and Team must appear on exactly ONE axis (rows OR columns), not both
    // - Combined, rows+columns must include all four types: Country, Position, League, Team
    const allTypes: CategoryType[] = ['Country', 'Position', 'League', 'Team', 'Shirt Number'];
    const fixCategoryLayout = (): boolean => {
      const rowSet = new Set<CategoryType>(rowCategoryTypes);
      const colSet = new Set<CategoryType>(columnCategoryTypes);
      const intersection = new Set<CategoryType>([...rowSet].filter(t => colSet.has(t)));
      const union = new Set<CategoryType>([...rowSet, ...colSet]);

      const hasCountryBoth = rowSet.has('Country') && colSet.has('Country');
      const hasTeamBoth = rowSet.has('Team') && colSet.has('Team');
      // Check for required types (Country, Position, League, Team - Shirt Number is optional)
      const requiredTypes: CategoryType[] = ['Country', 'Position', 'League', 'Team'];
      const missingTypes = requiredTypes.filter(t => !union.has(t));

      if (!hasCountryBoth && !hasTeamBoth && missingTypes.length === 0) {
        return false; // Layout already satisfies the constraints, no change needed
      }

      // Fallback to a deterministic, valid layout
      rowCategoryTypes = ['Country', 'Position', 'Position'];
      columnCategoryTypes = ['League', 'Team', 'Team'];
      return true; // Types were changed
    };

    // Fix category layout and check if types changed
    const typesChanged = fixCategoryLayout();
    
    // If types changed OR we couldn't find valid combinations, regenerate values to match types
    if (typesChanged || rowCategoryValues.length === 0) {
      // Clear and re-populate based on the current types
      rowCategoryValues = [];
      columnCategoryValues = [];
      
      // Try to find valid combinations with the new types
      let foundValid = false;
      for (let attempt = 0; attempt < 100 && !foundValid; attempt++) {
        const testRowValues: string[] = [];
        const testColValues: string[] = [];
        
        // Get candidate values for each type
        for (const catType of rowCategoryTypes) {
          const values = this.getCategoryValuesByDifficulty(catType);
          if (values.length > 0) {
            const shuffled = this.shuffle([...values]);
            testRowValues.push(shuffled[0].value);
          } else {
            break; // Can't find values for this type
          }
        }
        
        for (const catType of columnCategoryTypes) {
          const values = this.getCategoryValuesByDifficulty(catType);
          if (values.length > 0) {
            const shuffled = this.shuffle([...values]);
            testColValues.push(shuffled[0].value);
          } else {
            break; // Can't find values for this type
          }
        }
        
        // Verify all combinations have at least one matching player
        if (testRowValues.length === 3 && testColValues.length === 3) {
          // First check for duplicate values across all categories
          const allTestValues = [...testRowValues, ...testColValues];
          const uniqueTestValues = new Set(allTestValues);
          let allValid = allTestValues.length === uniqueTestValues.size; // No duplicates
          
          // Then verify all combinations have matching players
          if (allValid) {
            for (let row = 0; row < 3 && allValid; row++) {
              for (let col = 0; col < 3 && allValid; col++) {
                const rowType = rowCategoryTypes[row];
                const colType = columnCategoryTypes[col];
                const rowValue = testRowValues[row];
                const colValue = testColValues[col];
                
                const matches = allPlayers.filter(p => {
                  return this.checkMatchDual(p, rowType, rowValue, colType, colValue);
                });
                
                if (matches.length === 0) {
                  allValid = false;
                } else {
                  // Check if matches meet difficulty requirements
                  // For Easy mode: must have at least one Priority 1 player
                  if (gameDifficulty === 'easy') {
                    const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
                    if (priority1Matches.length === 0) {
                  allValid = false;
                    }
                  }
                  // For Medium mode: must have at least one Priority 1 or 2 player
                  else if (gameDifficulty === 'medium') {
                    const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
                    const priority2Matches = matches.filter(p => this.getPlayerPriority(p) === 2);
                    if (priority1Matches.length === 0 && priority2Matches.length === 0) {
                      allValid = false;
                    }
                  }
                  // For Hard mode: must have at least one Priority 1, 2, or 3 player
                  else if (gameDifficulty === 'hard') {
                    const priority1Matches = matches.filter(p => this.getPlayerPriority(p) === 1);
                    const priority2Matches = matches.filter(p => this.getPlayerPriority(p) === 2);
                    const priority3Matches = matches.filter(p => this.getPlayerPriority(p) === 3);
                    if (priority1Matches.length === 0 && priority2Matches.length === 0 && priority3Matches.length === 0) {
                      allValid = false;
                    }
                  }
                }
              }
            }
          }
          
          if (allValid) {
            rowCategoryValues = testRowValues;
            columnCategoryValues = testColValues;
            foundValid = true;
          }
        }
      }
      
      // If we still couldn't find valid combinations, use fallback (first available values)
      // But ensure no duplicates even in fallback
      if (!foundValid) {
        rowCategoryValues = [];
        columnCategoryValues = [];
        const usedValues = new Set<string>();
        
        for (const catType of rowCategoryTypes) {
          const values = this.getCategoryValuesByDifficulty(catType);
          // Find first value that hasn't been used yet
          for (const valueItem of values) {
            if (!usedValues.has(valueItem.value)) {
              rowCategoryValues.push(valueItem.value);
              usedValues.add(valueItem.value);
              break;
            }
          }
        }
        for (const catType of columnCategoryTypes) {
          const values = this.getCategoryValuesByDifficulty(catType);
          // Find first value that hasn't been used yet
          for (const valueItem of values) {
            if (!usedValues.has(valueItem.value)) {
              columnCategoryValues.push(valueItem.value);
              usedValues.add(valueItem.value);
              break;
            }
          }
        }
      }
    }

    // Build 4x4 grid
    const grid: GameCell[][] = [];
    const selectedPlayers: PlayerRecord[] = [];
    const selectedPlayerCombinations: Array<{
      player: PlayerRecord;
      rowCategoryType: CategoryType;
      rowCategoryValue: string;
      columnCategoryType: CategoryType;
      columnCategoryValue: string;
    }> = [];
    let priority1Count = 0;
    let priority2Count = 0;
    let priority3Count = 0;

    // First row: corner + column categories
    const firstRow: GameCell[] = [
      { player: null, category: null, mark: null }, // Corner cell
    ];
    for (let col = 0; col < 3; col++) {
      firstRow.push({
        player: null,
        category: columnCategoryTypes[col],
        mark: null,
      });
    }
    grid.push(firstRow);

    // Rows 1-3: row category + players matching both row and column categories
    for (let row = 0; row < 3; row++) {
      const rowCells: GameCell[] = [
        {
          player: null,
          category: rowCategoryTypes[row],
          mark: null,
        },
      ];

      const rowCategoryValue = rowCategoryValues[row];
      const rowCategoryType = rowCategoryTypes[row];

      for (let col = 0; col < 3; col++) {
        const columnCategoryValue = columnCategoryValues[col];
        const columnCategoryType = columnCategoryTypes[col];

        // Create a Set of already-selected player IDs to prevent duplicates
        const selectedPlayerIds = new Set(selectedPlayers.map(p => this.getPlayerId(p)));

        // Find players matching both categories (use checkMatchDual for proper position matching)
        // Exclude players that have already been selected
        const matchingPlayers = allPlayers.filter(p => {
          const matchesCategories = this.checkMatchDual(p, rowCategoryType, rowCategoryValue, columnCategoryType, columnCategoryValue);
          const notAlreadySelected = !selectedPlayerIds.has(this.getPlayerId(p));
          return matchesCategories && notAlreadySelected;
        });

        if (matchingPlayers.length > 0) {
          let selectedPlayer: PlayerRecord | null = null;
          
          // Select based on difficulty requirements using shuffled pools
          if (difficulty === 'easy') {
            // Easy: Only Priority 1 players allowed
            selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, 1, 'easy');
            if (selectedPlayer && this.getPlayerPriority(selectedPlayer) === 1) {
                priority1Count++;
            }
          } else if (difficulty === 'medium') {
            // Medium: Need at least 5 Priority 1 and 4 Priority 2 per game
            if (priority1Count < 5) {
              selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, 1, 'medium');
              if (selectedPlayer && this.getPlayerPriority(selectedPlayer) === 1) {
                priority1Count++;
              }
            } else if (priority2Count < 4) {
              selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, 2, 'medium');
              if (selectedPlayer && this.getPlayerPriority(selectedPlayer) === 2) {
                priority2Count++;
              }
            } else {
              // Already have minimums, use any matching player (random from shuffled pool)
              selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, null, 'medium');
              if (selectedPlayer) {
                const priority = this.getPlayerPriority(selectedPlayer);
                if (priority === 1) priority1Count++;
                else if (priority === 2) priority2Count++;
              }
            }
          } else {
            // Hard: Need at least 3 Priority 1, 3 Priority 2, and 3 Priority 3 per game
            if (priority1Count < 3) {
              selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, 1, 'hard');
              if (selectedPlayer && this.getPlayerPriority(selectedPlayer) === 1) {
                priority1Count++;
              }
            } else if (priority2Count < 3) {
              selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, 2, 'hard');
              if (selectedPlayer && this.getPlayerPriority(selectedPlayer) === 2) {
                priority2Count++;
              }
            } else if (priority3Count < 3) {
              selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, 3, 'hard');
              if (selectedPlayer && this.getPlayerPriority(selectedPlayer) === 3) {
                priority3Count++;
              }
            } else {
              // Already have minimums, use any matching player (random from shuffled pool)
              selectedPlayer = this.getNextMatchingPlayerFromShuffled(matchingPlayers, null, 'hard');
              if (selectedPlayer) {
                const priority = this.getPlayerPriority(selectedPlayer);
                if (priority === 1) priority1Count++;
                else if (priority === 2) priority2Count++;
                else if (priority === 3) priority3Count++;
              }
            }
          }
          
          // Fallback: if no player found from shuffled pools, use first matching player
          // BUT respect difficulty requirements - Easy mode must only use Priority 1
          if (!selectedPlayer && matchingPlayers.length > 0) {
            if (difficulty === 'easy') {
              // In Easy mode, only use Priority 1 players
              const priority1Matches = matchingPlayers.filter(p => this.getPlayerPriority(p) === 1);
              if (priority1Matches.length > 0) {
                selectedPlayer = priority1Matches[0];
              }
              // If no Priority 1 matches, leave selectedPlayer as null (will be handled below)
            } else {
              // Medium/Hard can use any matching player
              selectedPlayer = matchingPlayers[0];
            }
          }
          
          // Only add player if one was selected (should always be the case if matchingPlayers.length > 0)
          if (selectedPlayer) {
          selectedPlayers.push(selectedPlayer);
          selectedPlayerCombinations.push({
            player: selectedPlayer,
            rowCategoryType,
            rowCategoryValue,
            columnCategoryType,
            columnCategoryValue,
          });
          rowCells.push({
            player: selectedPlayer,
            category: null,
            mark: null,
          });
          } else {
            // This shouldn't happen, but handle gracefully if all matching players were already selected
            // If we're in easy mode and can't find a Priority 1 player, leave cell empty
            // This indicates a problem with category selection - should not happen in normal gameplay
            if (gameDifficulty === 'easy' && matchingPlayers.length > 0) {
              console.warn('Easy mode: Could not find Priority 1 player for cell, but matching players exist. Leaving cell empty to maintain difficulty requirement.');
              // Leave cell empty - do not use non-Priority 1 players in Easy mode
              rowCells.push({
                player: null,
                category: null,
                mark: null,
              });
            } else {
              rowCells.push({
                player: null,
                category: null,
                mark: null,
              });
            }
          }
        } else {
          // No match - this should be rare if we selected good categories
          rowCells.push({
            player: null,
            category: null,
            mark: null,
          });
        }
      }

      grid.push(rowCells);
    }

    // Calculate progress toward next level (based on games won)
    const progressToNextLevel = this.calculateProgressToNextLevel();

    return {
      id: `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      grid,
      rowCategories: rowCategoryValues,
      columnCategories: columnCategoryValues,
      rowCategoryTypes: rowCategoryTypes,
      columnCategoryTypes: columnCategoryTypes,
      currentTurn: 'user',
      winner: null,
      isComplete: false,
      size: 4,
      difficulty: gameDifficulty,
      previousDifficulty: previousDifficulty || undefined,
      progressToNextLevel,
      createdAt: new Date(),
    };
  }

  /**
   * Check if a player matches a category value
   */
  checkMatch(player: PlayerRecord, categoryType: CategoryType, categoryValue: string): boolean {
    const playerValue = this.getCategoryValue(player, categoryType);
    return playerValue === categoryValue;
  }

  /**
   * Check if a player matches both row and column categories (for 4x4 grid)
   * For Position categories, checks if player has ANY position matching the category
   */
  checkMatchDual(player: PlayerRecord, rowCategoryType: CategoryType, rowCategoryValue: string, 
                 columnCategoryType: CategoryType, columnCategoryValue: string): boolean {
    // For Position categories, check if player matches the position (they can have multiple positions)
    let rowMatches: boolean;
    if (rowCategoryType === 'Position') {
      rowMatches = this.playerMatchesPositionCategory(player, rowCategoryValue);
    } else {
      const playerRowValue = this.getCategoryValue(player, rowCategoryType);
      rowMatches = playerRowValue === rowCategoryValue;
    }
    
    let colMatches: boolean;
    if (columnCategoryType === 'Position') {
      colMatches = this.playerMatchesPositionCategory(player, columnCategoryValue);
    } else {
      const playerColValue = this.getCategoryValue(player, columnCategoryType);
      colMatches = playerColValue === columnCategoryValue;
    }
    
    return rowMatches && colMatches;
  }

  /**
   * Normalize position to one of 4 groups: Keeper, Defender, Midfielder, Forward
   * Checks Forward positions first since players can have multiple positions (e.g., "AM / LW / RW / ST")
   */
  private normalizePosition(position: string): string {
    if (!position) return '';
    const pos = position.toUpperCase();
    
    // Keeper (highest priority - most specific)
    if (pos.includes('GK') || pos.includes('GOALKEEPER')) {
      return 'Keeper';
    }
    
    // Forward (check before Midfielder since players can be "AM / LW / RW / ST")
    // Forward indicators take precedence over midfielder indicators
    if (pos.includes('FW') || pos.includes('FORWARD') || pos.includes('ST') || 
        pos.includes('SS') || pos.includes('LW') || pos.includes('RW') || pos.includes('CF') ||
        pos.includes('WING') || pos.includes('ATTACK')) {
      return 'Forward';
    }
    
    // Defender
    if (pos.includes('DF') || pos.includes('DEFENDER') || pos.includes('CB') || 
        pos.includes('LB') || pos.includes('RB') || pos.includes('LWB') || pos.includes('RWB')) {
      return 'Defender';
    }
    
    // Midfielder (check after Forward to avoid misclassifying "AM / LW / RW / ST" as Midfielder)
    if (pos.includes('MF') || pos.includes('MIDFIELDER') || pos.includes('CM') || 
        pos.includes('DM') || pos.includes('AM') || pos.includes('LM') || pos.includes('RM')) {
      return 'Midfielder';
    }
    
    return 'Midfielder'; // Default fallback
  }

  /**
   * Check if a player's position matches a specific position category
   * Returns true if the player has ANY position that matches the category
   * This allows players with multiple positions (e.g., "AM / LW / RW / ST") to match multiple categories
   */
  private playerMatchesPositionCategory(player: PlayerRecord, categoryValue: string): boolean {
    if (!player.Position) return false;
    const pos = player.Position.toUpperCase().trim();
    const normalizedCategory = categoryValue.toUpperCase().trim();
    
    // Check if player has any position matching the category
    switch (normalizedCategory) {
      case 'KEEPER':
      case 'GOALKEEPER':
        return pos.includes('GK') || pos.includes('GOALKEEPER');
      
      case 'DEFENDER':
        return pos.includes('DF') || pos.includes('DEFENDER') || pos.includes('CB') || 
               pos.includes('LB') || pos.includes('RB') || pos.includes('LWB') || pos.includes('RWB');
      
      case 'MIDFIELDER':
        return pos.includes('MF') || pos.includes('MIDFIELDER') || pos.includes('CM') || 
               pos.includes('DM') || pos.includes('AM') || pos.includes('LM') || pos.includes('RM');
      
      case 'FORWARD':
        // Check for any forward position indicators
        return pos.includes('FW') || pos.includes('FORWARD') || pos.includes('ST') || 
               pos.includes('SS') || pos.includes('LW') || pos.includes('RW') || pos.includes('CF') ||
               pos.includes('WING') || pos.includes('ATTACK');
      
      default:
        // Fallback: normalize and compare (handles case variations)
        const normalized = this.normalizePosition(player.Position);
        return normalized.toUpperCase().trim() === normalizedCategory;
    }
  }

  /**
   * Get the correct value for a category from a player
   * For Position category, returns normalized position (used for game generation)
   * For matching, use playerMatchesPositionCategory instead
   */
  getCategoryValue(player: PlayerRecord, category: CategoryType): string {
    switch (category) {
      case 'Country':
        return player.Country;
      case 'Position':
        // Normalize position to 4 groups (for game generation)
        return this.normalizePosition(player.Position);
      case 'League':
        return player.League;
      case 'Team':
        return player.Team;
      case 'Shirt Number':
        return player['Shirt Number'] || '';
      default:
        return '';
    }
  }

  /**
   * User makes a move (places O)
   * Returns true if move is valid and made
   * For 4x4 grid: player must match BOTH row category AND column category
   */
  makeUserMove(game: Game, row: number, col: number): { success: boolean; game: Game; message?: string } {
    if (game.isComplete) {
      return { success: false, game, message: 'Game is already complete' };
    }

    if (game.currentTurn !== 'user') {
      return { success: false, game, message: 'Not your turn' };
    }

    // 4x4 grid: row 0 is header, rows 1-3 are data rows
    // col 0 is row category, cols 1-3 are player cells
    if (row < 1 || row >= 4 || col < 1 || col >= 4) {
      return { success: false, game, message: 'Invalid cell coordinates' };
    }

    const cell = game.grid[row][col];
    
    // Can't place on empty cell
    if (!cell.player) {
      return { success: false, game, message: 'Cannot place mark on empty cell' };
    }

    // Cell already has a mark
    if (cell.mark !== null) {
      return { success: false, game, message: 'Cell already has a mark' };
    }

    // Check if player matches BOTH row category AND column category
    const rowCategoryCell = game.grid[row][0];
    const columnCategoryCell = game.grid[0][col];
    
    if (!rowCategoryCell.category || !columnCategoryCell.category) {
      return { success: false, game, message: 'Invalid category' };
    }

    // Get category values from game metadata
    const rowCategoryValue = game.rowCategories[row - 1];
    const columnCategoryValue = game.columnCategories[col - 1];
    const rowCategoryType = rowCategoryCell.category;
    const columnCategoryType = columnCategoryCell.category;

    // Player must match both categories
    if (!this.checkMatchDual(cell.player, rowCategoryType, rowCategoryValue, columnCategoryType, columnCategoryValue)) {
      return { success: false, game, message: 'Player does not match both row and column categories' };
    }

    // Place O
    const updatedGrid = game.grid.map((r, rIdx) => 
      r.map((c, cIdx) => 
        (rIdx === row && cIdx === col) 
          ? { ...c, mark: 'O' as CellMark }
          : c
      )
    );

    const updatedGame: Game = {
      ...game,
      grid: updatedGrid,
      currentTurn: 'ai',
    };

    // Check for win or draw
    const checkedGame = this.checkGameState(updatedGame);
    return { success: true, game: checkedGame };
  }

  /**
   * Normalize string for fuzzy matching (remove accents, lowercase)
   */
  private normalizeString(str: string): string {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/[^a-z0-9\s]/g, '') // Remove special chars
      .trim();
  }

  /**
   * Guess a player for a cell
   * Returns success if the guessed player matches the cell's category requirements
   * (row category AND column category)
   */
  guessPlayer(game: Game, row: number, col: number, playerName: string): { success: boolean; game: Game; message?: string } {
    if (game.isComplete) {
      return { success: false, game, message: 'Game is already complete' };
    }

    // 4x4 grid: row 0 is header, rows 1-3 are data rows
    // col 0 is row category, cols 1-3 are player cells
    if (row < 1 || row >= 4 || col < 1 || col >= 4) {
      return { success: false, game, message: 'Invalid cell coordinates' };
    }

    const cell = game.grid[row][col];
    
    // Cell already has a mark
    if (cell.mark !== null) {
      return { success: false, game, message: 'Cell already has a guess' };
    }

    // Get the row and column category types and values for this cell
    const rowIndex = row - 1; // Convert to 0-based index
    const colIndex = col - 1; // Convert to 0-based index
    
    if (rowIndex >= game.rowCategories.length || colIndex >= game.columnCategories.length) {
      return { success: false, game, message: 'Invalid category indices' };
    }

    const rowCategoryType = game.rowCategoryTypes[rowIndex];
    const rowCategoryValue = game.rowCategories[rowIndex];
    const columnCategoryType = game.columnCategoryTypes[colIndex];
    const columnCategoryValue = game.columnCategories[colIndex];

    // Find the player by name (fuzzy match)
    const allPlayers = this.squadStore.getAll();
    const normalizedGuess = this.normalizeString(playerName);
    
    const guessedPlayer = allPlayers.find(player => {
      const normalizedName = this.normalizeString(player.Name);
      return normalizedName === normalizedGuess;
    });

    if (!guessedPlayer) {
      return { 
        success: false, 
        game, 
        message: `Player "${playerName}" not found. Try again or skip your turn!` 
      };
    }

    // Check if the guessed player matches both categories
    const matchesCategories = this.checkMatchDual(
      guessedPlayer,
      rowCategoryType,
      rowCategoryValue,
      columnCategoryType,
      columnCategoryValue
    );

    if (!matchesCategories) {
      return { 
        success: false, 
        game, 
        message: `Incorrect. ${guessedPlayer.Name} does not match both categories. Try again or skip your turn!` 
      };
    }

    // Place O mark for correct guess and update cell with the guessed player
    const updatedGrid = game.grid.map((r, rIdx) => 
      r.map((c, cIdx) => 
        (rIdx === row && cIdx === col) 
          ? { ...c, player: guessedPlayer, mark: 'O' as CellMark }
          : c
      )
    );

    const updatedGame: Game = {
      ...game,
      grid: updatedGrid,
      currentTurn: 'ai', // Switch to AI after correct guess
    };

    // Check for win
    const checkedGame = this.checkGameState(updatedGame);
    
    // Don't make AI move here - let the caller add a delay first
    // This makes the AI feel less automatic and more natural
    // The MCP server handler will call makeAIMove after a delay
    
    return { 
      success: true, 
      game: checkedGame, 
      message: `Correct! ${guessedPlayer.Name} matches both categories.` 
    };
  }

  /**
   * AI makes a move (places X with player name)
   * AI tries to place X on players that DON'T match the category
   */
  makeAIMove(game: Game): { success: boolean; game: Game; message?: string } {
    if (game.isComplete) {
      return { success: false, game, message: 'Game is already complete' };
    }

    if (game.currentTurn !== 'ai') {
      return { success: false, game, message: 'Not AI turn' };
    }

    // Find all available cells (no mark, has player, doesn't match both categories)
    const availableMoves: Array<{ row: number; col: number; player: PlayerRecord }> = [];

    for (let row = 1; row < 4; row++) {
      const rowCategoryCell = game.grid[row][0];
      if (!rowCategoryCell.category) continue;

      for (let col = 1; col < 4; col++) {
        const columnCategoryCell = game.grid[0][col];
        if (!columnCategoryCell.category) continue;

        const cell = game.grid[row][col];
        if (cell.mark === null && cell.player) {
          // Get category values
          const rowCategoryValue = game.rowCategories[row - 1];
          const columnCategoryValue = game.columnCategories[col - 1];
          const rowCategoryType = rowCategoryCell.category;
          const columnCategoryType = columnCategoryCell.category;

          // AI prefers cells where player doesn't match both categories
          if (!this.checkMatchDual(cell.player, rowCategoryType, rowCategoryValue, columnCategoryType, columnCategoryValue)) {
            availableMoves.push({ row, col, player: cell.player });
          }
        }
      }
    }

    // If no "wrong" moves available, pick any available cell
    if (availableMoves.length === 0) {
      for (let row = 1; row < 4; row++) {
        for (let col = 1; col < 4; col++) {
          const cell = game.grid[row][col];
          if (cell.mark === null && cell.player) {
            availableMoves.push({ row, col, player: cell.player });
          }
        }
      }
    }

    if (availableMoves.length === 0) {
      // No moves available - game is a draw
      const updatedGame: Game = {
        ...game,
        currentTurn: 'user',
        isComplete: true,
        winner: 'draw',
      };
      return { success: true, game: updatedGame };
    }

    // Strategic AI with some imperfection to allow players to win
    // Always try to win (too obvious to skip), but sometimes miss blocks or optimal positions
    let move = this.findBestMove(game, availableMoves, true); // Pass flag to allow imperfection
    
    // Fallback to random if no strategic move found
    if (!move) {
      move = availableMoves[Math.floor(Math.random() * availableMoves.length)];
    }

    // Place X (AI mark)
    const updatedGrid = game.grid.map((r, rIdx) => 
      r.map((c, cIdx) => 
        (rIdx === move.row && cIdx === move.col) 
          ? { ...c, mark: 'X' as CellMark }
          : c
      )
    );

    const updatedGame: Game = {
      ...game,
      grid: updatedGrid,
      currentTurn: 'user',
    };

    // Check for win or draw
    const checkedGame = this.checkGameState(updatedGame);
    return { success: true, game: checkedGame };
  }

  /**
   * Find the best strategic move for AI
   * Priority: 1) Win, 2) Best position (center/corner), 3) Block user (only as last resort), 4) Random
   * With some imperfection to allow strategic players to win
   */
  private findBestMove(game: Game, availableMoves: Array<{ row: number; col: number; player: PlayerRecord }>, allowImperfection: boolean = false): { row: number; col: number; player: PlayerRecord } | null {
    // 1. Always try to find a winning move (AI gets 3 in a row) - too obvious to skip
    for (const move of availableMoves) {
      const testGrid = game.grid.map((r, rIdx) => 
        r.map((c, cIdx) => 
          (rIdx === move.row && cIdx === move.col) 
            ? { ...c, mark: 'X' as CellMark }
            : c
        )
      );
      const testGame = { ...game, grid: testGrid };
      const winner = this.checkWinner(testGame);
      if (winner === 'ai') {
        return move; // Found winning move!
      }
    }

    // 2. Prefer center cell (best strategic position in tic-tac-toe)
    // But with imperfection: 70% chance to take center, 30% chance to make random move
    const centerMove = availableMoves.find(m => m.row === 2 && m.col === 2);
    if (centerMove) {
      if (allowImperfection && Math.random() < 0.30) {
        // 30% chance to skip center (allows strategic players to control the board)
        // Continue to next strategy
      } else {
        // 70% chance to take center
        return centerMove;
      }
    }

    // 3. Prefer corner cells (second best)
    // But with imperfection: 60% chance to take corner, 40% chance to make random move
    const corners = [
      { row: 1, col: 1 },
      { row: 1, col: 3 },
      { row: 3, col: 1 },
      { row: 3, col: 3 }
    ];
    const cornerMoves: Array<{ row: number; col: number; player: PlayerRecord }> = [];
    for (const corner of corners) {
      const cornerMove = availableMoves.find(m => m.row === corner.row && m.col === corner.col);
      if (cornerMove) {
        cornerMoves.push(cornerMove);
      }
    }
    
    if (cornerMoves.length > 0) {
      if (allowImperfection && Math.random() < 0.40) {
        // 40% chance to skip corner (allows more strategic play)
        // Continue to blocking check
      } else {
        // 60% chance to take a corner
        return cornerMoves[Math.floor(Math.random() * cornerMoves.length)];
      }
    }

    // 4. Only block user from winning if no other good moves available (last resort)
    // This allows players to set up traps and win strategically
    const blockingMoves: Array<{ row: number; col: number; player: PlayerRecord }> = [];
    for (const move of availableMoves) {
      const testGrid = game.grid.map((r, rIdx) => 
        r.map((c, cIdx) => 
          (rIdx === move.row && cIdx === move.col) 
            ? { ...c, mark: 'O' as CellMark }
            : c
        )
      );
      const testGame = { ...game, grid: testGrid };
      const winner = this.checkWinner(testGame);
      if (winner === 'user') {
        blockingMoves.push(move); // Found a blocking move
      }
    }
    
    // Only block if we have no other strategic moves left
    // This makes the AI less defensive and allows players to win
    if (blockingMoves.length > 0) {
      // Check if we have any non-blocking moves that are strategic (center/corner)
      const nonBlockingMoves = availableMoves.filter(m => 
        !blockingMoves.some(bm => bm.row === m.row && bm.col === m.col)
      );
      
      const hasStrategicNonBlocking = nonBlockingMoves.some(m => {
        // Check if it's center or corner
        return (m.row === 2 && m.col === 2) || 
               (m.row === 1 && m.col === 1) ||
               (m.row === 1 && m.col === 3) ||
               (m.row === 3 && m.col === 1) ||
               (m.row === 3 && m.col === 3);
      });
      
      // Only block if there are no strategic non-blocking moves available
      if (!hasStrategicNonBlocking) {
        return blockingMoves[Math.floor(Math.random() * blockingMoves.length)];
      }
      // Otherwise, continue to random fallback (which will pick from non-blocking moves)
    }

    // 5. Return null to use random fallback
    return null;
  }

  /**
   * Check game state for wins or draws
   */
  private checkGameState(game: Game): Game {
    // Check for wins (3 in a row, column, or diagonal)
    const winner = this.checkWinner(game);
    
    if (winner) {
      // Track the game result for difficulty progression
      this.lastGameWinner = winner;
      
      // Update win counter for progress
      if (winner === 'user') {
        this.gamesWonAtCurrentDifficulty++;
      } else {
        // Reset win counter on loss or draw
        this.gamesWonAtCurrentDifficulty = 0;
      }
      
      // Calculate progress (only for wins)
      const progressToNextLevel = winner === 'user' 
        ? this.calculateProgressToNextLevel() 
        : 0; // Reset to 0 on loss
      
      return {
        ...game,
        winner,
        isComplete: true,
        progressToNextLevel,
      };
    }

    // Check for draw (all playable cells filled - rows 1-3, cols 1-3)
    const allFilled = game.grid.slice(1, 4).every((row) => 
      row.slice(1, 4).every((cell) => cell.mark !== null)
    );

    if (allFilled) {
      // Track the game result for difficulty progression
      this.lastGameWinner = 'draw';
      
      // Reset win counter on draw (treat as loss)
      this.gamesWonAtCurrentDifficulty = 0;
      const progressToNextLevel = 0;
      
      return {
        ...game,
        isComplete: true,
        winner: 'draw',
        progressToNextLevel,
      };
    }

    // Update progress for ongoing game
    const progressToNextLevel = this.calculateProgressToNextLevel();
    return {
      ...game,
      progressToNextLevel,
    };
  }

  /**
   * Check if there's a winner (3 in a row in the 3x3 playable area: rows 1-3, cols 1-3)
   * 'O' = user wins, 'X' = AI wins
   */
  private checkWinner(game: Game): 'user' | 'ai' | null {
    // Check rows (in playable area: rows 1-3, cols 1-3)
    for (let row = 1; row < 4; row++) {
      const marks = [game.grid[row][1].mark, game.grid[row][2].mark, game.grid[row][3].mark];
      if (marks[0] === 'O' && marks[1] === 'O' && marks[2] === 'O') {
        return 'user';
      }
      if (marks[0] === 'X' && marks[1] === 'X' && marks[2] === 'X') {
        return 'ai';
      }
    }

    // Check columns (in playable area)
    for (let col = 1; col < 4; col++) {
      const marks = [game.grid[1][col].mark, game.grid[2][col].mark, game.grid[3][col].mark];
      if (marks[0] === 'O' && marks[1] === 'O' && marks[2] === 'O') {
        return 'user';
      }
      if (marks[0] === 'X' && marks[1] === 'X' && marks[2] === 'X') {
        return 'ai';
      }
    }

    // Check diagonal (top-left to bottom-right in playable area)
    const diag1 = [game.grid[1][1].mark, game.grid[2][2].mark, game.grid[3][3].mark];
    if (diag1[0] === 'O' && diag1[1] === 'O' && diag1[2] === 'O') {
      return 'user';
    }
    if (diag1[0] === 'X' && diag1[1] === 'X' && diag1[2] === 'X') {
      return 'ai';
    }

    // Check diagonal (top-right to bottom-left in playable area)
    const diag2 = [game.grid[1][3].mark, game.grid[2][2].mark, game.grid[3][1].mark];
    if (diag2[0] === 'O' && diag2[1] === 'O' && diag2[2] === 'O') {
      return 'user';
    }
    if (diag2[0] === 'X' && diag2[1] === 'X' && diag2[2] === 'X') {
      return 'ai';
    }

    return null;
  }

  /**
   * Get all unique values for a category type from the squad
   */
  getCategoryOptions(category: CategoryType): string[] {
    const players = this.squadStore.getAll();
    const values = new Set<string>();

    players.forEach((player) => {
      const value = this.getCategoryValue(player, category);
      if (value) {
        values.add(value);
      }
    });

    return Array.from(values).sort();
  }

  /**
   * Shuffle array (Fisher-Yates)
   */
  private shuffle<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
}

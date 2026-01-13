/**
 * Cloudflare Worker entry point
 * Converts Express app to Cloudflare Workers format
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { GameEngine } from "./GameEngine.js";
import { SquadStoreWorker } from "./SquadStoreWorker.js";
import { GameStore } from "./GameStore.js";
import type { Game, PlayerRecord } from "./types.js";
import { CSV_DATA } from "./bundled-data.js";

// Environment interface for Cloudflare Workers
interface Env {
  ASSETS: any; // Assets binding for static files
  GAME_STORE: any; // Durable Object namespace
}

// Initialize stores (using bundled data)
// Note: SquadStoreWorker has same interface as SquadStore (getAll, search methods)
const squadStore = new SquadStoreWorker(CSV_DATA);
// @ts-ignore - SquadStoreWorker has compatible interface
const gameEngine = new GameEngine(squadStore);

// Helper to create tool response with game state for widget
const replyWithGame = (message: string, game: Game) => {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    structuredContent: { game },
  };
};

// Input schemas
const createGameInputSchema = z.object({
  resetDifficulty: z.boolean().optional(), // Optional flag to reset difficulty to easy
  // Optional overrides sent from the widget to preserve progress when the server
  // cannot read previously saved progress (e.g., stateless worker instance).
  progressOverride: z.number().optional(), // Percentage 0-100
  winsOverride: z.number().optional(), // Wins at current difficulty
  difficultyOverride: z.enum(['easy', 'medium', 'hard']).optional(),
});
const getGameInputSchema = z.object({
  gameId: z.string().min(1),
});
const makeMoveInputSchema = z.object({
  gameId: z.string().min(1),
  row: z.number().int().min(1).max(3),
  col: z.number().int().min(1).max(3),
});
const aiMoveInputSchema = z.object({
  gameId: z.string().min(1),
});
const guessPlayerInputSchema = z.object({
  gameId: z.string().min(1),
  row: z.number().int().min(1).max(3),
  col: z.number().int().min(1).max(3),
  playerName: z.string().min(1),
});
const skipTurnInputSchema = z.object({
  gameId: z.string().min(1),
});
const searchPlayersInputSchema = z.object({
  team: z.string().optional(),
  country: z.string().optional(),
  position: z.string().optional(),
  league: z.string().optional(),
});

// Helper to get game from Durable Object
async function getGame(env: Env, gameId: string): Promise<Game | null> {
  const id = env.GAME_STORE.idFromName(gameId);
  const stub = env.GAME_STORE.get(id);
  const response = await stub.fetch(new Request("http://dummy/"));
  const data = await response.json();
  return data.game || null;
}

// Helper to save game to Durable Object
async function saveGame(env: Env, game: Game): Promise<void> {
  const id = env.GAME_STORE.idFromName(game.id);
  const stub = env.GAME_STORE.get(id);
  await stub.fetch(new Request("http://dummy/", {
    method: "PUT",
    body: JSON.stringify({ game }),
  }));
}

// Helper to save difficulty progress to Durable Object
async function saveDifficultyProgress(env: Env, state: {
  currentDifficulty: 'easy' | 'medium' | 'hard';
  gamesWonAtCurrentDifficulty: number;
  lastGameWinner: 'user' | 'ai' | 'draw' | null;
}): Promise<void> {
  const id = env.GAME_STORE.idFromName("user_progress");
  const stub = env.GAME_STORE.get(id);
  await stub.fetch(new Request("http://dummy/progress", {
    method: "PUT",
    body: JSON.stringify({ progress: state }),
  }));
}

// Helper to load difficulty progress from Durable Object
async function loadDifficultyProgress(env: Env): Promise<{
  currentDifficulty: 'easy' | 'medium' | 'hard';
  gamesWonAtCurrentDifficulty: number;
  lastGameWinner: 'user' | 'ai' | 'draw' | null;
} | null> {
  const id = env.GAME_STORE.idFromName("user_progress");
  const stub = env.GAME_STORE.get(id);
  const response = await stub.fetch(new Request("http://dummy/progress", {
    method: "GET",
  }));
  
  if (response.status === 404) {
    return null;
  }
  
  const data = await response.json();
  if (data.progress) {
    return data.progress;
  }
  
  return null;
}

// Helper to load widget HTML from Assets and inject image URLs
async function loadGameHtml(env: Env, request: Request): Promise<string> {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  
  // Try to load from Assets
  try {
    const assetResponse = await env.ASSETS.fetch(new Request(`${baseUrl}/game-widget.html`));
    if (assetResponse.ok) {
      let gameHtml = await assetResponse.text();
      
      // Build image URLs map (images are served from Assets, not bundled)
      // The widget will load images from /images/ paths
      const imageUrls: Record<string, string> = {};
      // Common image files that the widget uses
      const imageFiles = [
        'soccer_pitch.png', 'barca.png', 'madrid.png', 'atletico.svg', 'mancity.png',
        'united.png', 'Chelsea.png', 'Liverpool_FC.png', 'arsenal.png', 'tottenham.png',
        'bayern.svg', 'Soccer_Player.png', 'Shirt_Number.png', 'Goalkeeper.webp',
        'holand.png', 'norway.png', 'bayern.svg', 'LaLiga.png', 'premier.png',
        'England.png', 'Spain.png', 'belgium.svg', 'brazil.webp', 'france.webp',
        'germany.webp', 'italy.png', 'portugal.png', 'sweden.svg', 'uruguay.png',
        'afa.png', 'Logo.png'
      ];
      
      for (const imageFile of imageFiles) {
        imageUrls[imageFile] = `${baseUrl}/images/${imageFile}`;
      }
      
      // Inject image URLs and server URL
      const imageDataScript = `
    <script>
      window.IMAGE_DATA_URIS = ${JSON.stringify(imageUrls)};
      window.MCP_SERVER_URL = ${JSON.stringify(baseUrl)};
    </script>
  `;
      const scriptMatch = gameHtml.match(/<script[^>]*>/);
      if (scriptMatch) {
        gameHtml = gameHtml.replace(scriptMatch[0], imageDataScript + scriptMatch[0]);
      } else if (gameHtml.includes('</head>')) {
        gameHtml = gameHtml.replace('</head>', imageDataScript + '</head>');
      } else {
        gameHtml = imageDataScript + gameHtml;
      }
      return gameHtml;
    }
  } catch (error) {
    console.error("Error loading widget HTML:", error);
  }
  
  // Fallback: return basic HTML
  return `<!DOCTYPE html><html><head><title>Rabona</title></head><body><h1>Rabona</h1><p>Widget loading...</p></body></html>`;
}

// Cache widget HTML to avoid reloading on every request
let cachedWidgetHtml: string | null = null;
let widgetHtmlCacheTime = 0;
const WIDGET_CACHE_TTL = 60000; // Cache for 60 seconds

// Registry for tools and resources (for direct protocol handling)
interface ToolRegistry {
  name: string;
  definition: any;
  handler: (args: any) => Promise<any>;
}

interface ResourceRegistry {
  name: string;
  uri: string;
  definition: any;
  handler: (args: any) => Promise<any>;
}

const toolRegistry = new Map<string, ToolRegistry>();
const resourceRegistry = new Map<string, ResourceRegistry>();
let registryPopulated = false;

// Create MCP server
function createMcpServer(env: Env, request: Request) {
  const server = new McpServer({
    name: "rabona",
    version: "1.0.0",
  });
  
  // Populate registry on first call (lazy initialization)
  if (!registryPopulated) {
    // Register widget resource (lazy loading - don't load HTML until actually requested)
    const widgetHandler = async () => {
      // Use cached HTML if available and fresh
      const now = Date.now();
      if (cachedWidgetHtml && (now - widgetHtmlCacheTime) < WIDGET_CACHE_TTL) {
        return {
          contents: [
            {
              uri: "ui://widget/game-widget.html",
              mimeType: "text/html+skybridge",
              text: cachedWidgetHtml,
              _meta: { "openai/widgetPrefersBorder": true },
            },
          ],
        };
      }
      
      // Load and cache widget HTML (only when resource is actually read)
      const gameHtml = await loadGameHtml(env, request);
      cachedWidgetHtml = gameHtml;
      widgetHtmlCacheTime = now;
      
      return {
        contents: [
          {
            uri: "ui://widget/game-widget.html",
            mimeType: "text/html+skybridge",
            text: gameHtml,
            _meta: { "openai/widgetPrefersBorder": true },
          },
        ],
      };
    };
  
  server.registerResource(
    "game-widget",
    "ui://widget/game-widget.html",
    {},
    widgetHandler
  );
  
  // Register in our registry
  resourceRegistry.set("game-widget", {
    name: "game-widget",
    uri: "ui://widget/game-widget.html",
    definition: {},
    handler: widgetHandler,
  });

  // Register create_game tool
  const createGameHandler = async (args: any) => {
    // Reset difficulty if requested (e.g., when user exits after losing)
    const shouldReset = args.resetDifficulty === true;
    
    // Load saved progress if not resetting
    let savedProgress: {
      currentDifficulty: 'easy' | 'medium' | 'hard';
      gamesWonAtCurrentDifficulty: number;
      lastGameWinner: 'user' | 'ai' | 'draw' | null;
    } | null = null;
    
    if (!shouldReset) {
      savedProgress = await loadDifficultyProgress(env);
      if (savedProgress) {
        gameEngine.restoreDifficultyState(savedProgress);
      } else {
        // Fallback: Try to get progress from the last completed game
        // This is a backup in case Durable Object progress storage fails
        // We can't easily get the last game, so we'll rely on Durable Objects
        // But at least we know savedProgress is null
      }
    }
    
    // Get previous difficulty before generating (to track transitions)
    const previousDifficulty = gameEngine.getDifficultyState().currentDifficulty;
    
    // Apply overrides from client if provided (fallback when server state not restored)
    if (!shouldReset && (args.progressOverride !== undefined || args.winsOverride !== undefined || args.difficultyOverride !== undefined)) {
      const winsOverride = typeof args.winsOverride === 'number' ? args.winsOverride : undefined;
      const difficultyOverride = args.difficultyOverride as ('easy' | 'medium' | 'hard') | undefined;
      if (difficultyOverride) {
        gameEngine.restoreDifficultyState({
          currentDifficulty: difficultyOverride,
          gamesWonAtCurrentDifficulty: winsOverride ?? gameEngine.getDifficultyState().gamesWonAtCurrentDifficulty,
          lastGameWinner: 'user',
        });
      } else if (winsOverride !== undefined) {
        const currentState = gameEngine.getDifficultyState();
        gameEngine.restoreDifficultyState({
          currentDifficulty: currentState.currentDifficulty,
          gamesWonAtCurrentDifficulty: winsOverride,
          lastGameWinner: 'user',
        });
      }
    }

    const game = gameEngine.generateGame(undefined, shouldReset);
    
    // Get new difficulty after generation (may have progressed)
    const newDifficulty = gameEngine.getDifficultyState().currentDifficulty;
    
    // If difficulty progressed, update the game's previousDifficulty field
    if (previousDifficulty !== newDifficulty) {
      game.previousDifficulty = previousDifficulty;
    }
    
    // CRITICAL: Always override progressToNextLevel from saved progress if available
    // This is the source of truth for progress persistence
    let finalProgress = 0;
    
    // If client sent a progressOverride, trust it
    if (!shouldReset && typeof args.progressOverride === 'number') {
      finalProgress = Math.max(0, Math.min(100, Math.round(args.progressOverride)));
    } else if (shouldReset) {
      // Explicitly set to 0 on reset
      finalProgress = 0;
    } else if (savedProgress) {
      // ALWAYS use saved progress if it exists
      // Calculate progress from saved state - this is the source of truth
      finalProgress = savedProgress.currentDifficulty === 'easy' || savedProgress.currentDifficulty === 'medium'
        ? Math.min(100, Math.round((savedProgress.gamesWonAtCurrentDifficulty / 5) * 100))
        : 100;
    } else {
      // No saved progress - check GameEngine state as fallback
      const currentState = gameEngine.getDifficultyState();
      finalProgress = currentState.currentDifficulty === 'easy' || currentState.currentDifficulty === 'medium'
        ? Math.min(100, Math.round((currentState.gamesWonAtCurrentDifficulty / 5) * 100))
        : 100;
    }

    // If difficulty progressed (easy -> medium or medium -> hard), start progress at 0
    if (previousDifficulty !== newDifficulty) {
      finalProgress = 0;
      // Ensure engine state reflects 0 wins at new difficulty
      const resetState = {
        currentDifficulty: newDifficulty,
        gamesWonAtCurrentDifficulty: 0,
        lastGameWinner: null as 'user' | 'ai' | 'draw' | null,
      };
      gameEngine.restoreDifficultyState(resetState);
      savedProgress = resetState;
    }
    
    // ALWAYS set the progress - this ensures it's never undefined or wrong
    // Force it to be a number, not undefined
    game.progressToNextLevel = finalProgress;
    
    // CRITICAL: Save progress AFTER setting it on the game
    // Use the saved progress value if available, otherwise use GameEngine state
    // This ensures we don't overwrite the saved progress with a reset value
    if (shouldReset) {
      // On reset, save fresh state (0 wins)
      const progressState = gameEngine.getDifficultyState();
      await saveDifficultyProgress(env, progressState);
    } else if (savedProgress) {
      // Keep the saved progress - don't overwrite it with GameEngine state
      // The GameEngine state might have been reset or changed during generateGame()
      await saveDifficultyProgress(env, savedProgress);
    } else {
      // No saved progress - save current GameEngine state
      const progressState = gameEngine.getDifficultyState();
      await saveDifficultyProgress(env, progressState);
    }
    
    await saveGame(env, game);
    
    // Debug: Include progress info in the response message for verification
    const debugMsg = savedProgress 
      ? `Progress: ${savedProgress.gamesWonAtCurrentDifficulty} wins = ${finalProgress}%`
      : `No saved progress, using ${finalProgress}%`;
    
    return replyWithGame(`Created new game: ${game.id}. ${debugMsg}`, game);
  };
  
  server.registerTool(
    "create_game",
    {
      title: "Create Game",
      description: "Creates a new tic-tac-toe game with soccer players.",
      inputSchema: createGameInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Creating new game...",
        "openai/toolInvocation/invoked": "Game created!",
      },
    },
    createGameHandler
  );
  
  toolRegistry.set("create_game", {
    name: "create_game",
    definition: {
      title: "Create Game",
      description: "Creates a new tic-tac-toe game with soccer players.",
      inputSchema: createGameInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Creating new game...",
        "openai/toolInvocation/invoked": "Game created!",
      },
    },
    handler: createGameHandler,
  });

  // Register get_game tool
  const getGameHandler = async (args: any) => {
    const game = await getGame(env, args.gameId);
    if (!game) {
      return {
        content: [],
        structuredContent: { error: `Game ${args.gameId} not found.` },
      };
    }
    return replyWithGame("", game);
  };
  
  server.registerTool(
    "get_game",
    {
      title: "Get Game",
      description: "Gets the current state of a game.",
      inputSchema: getGameInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
      },
    },
    getGameHandler
  );
  
  toolRegistry.set("get_game", {
    name: "get_game",
    definition: {
      title: "Get Game",
      description: "Gets the current state of a game.",
      inputSchema: getGameInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
      },
    },
    handler: getGameHandler,
  });

  // Register make_move tool
  const makeMoveHandler = async (args: any) => {
    const game = await getGame(env, args.gameId);
    if (!game) {
      return {
        content: [],
        structuredContent: { error: `Game ${args.gameId} not found.` },
      };
    }

    const result = gameEngine.makeUserMove(game, args.row, args.col);
    if (result.success) {
      await saveGame(env, result.game);
      
      // Save progress if game completed
      if (result.game.isComplete) {
        const progressState = gameEngine.getDifficultyState();
        // CRITICAL: Ensure we're saving the correct state
        // If user won, gamesWonAtCurrentDifficulty should be > 0
        if (result.game.winner === 'user' && progressState.gamesWonAtCurrentDifficulty === 0) {
          // This shouldn't happen, but if it does, the state wasn't updated correctly
          console.error('ERROR: User won but gamesWonAtCurrentDifficulty is 0!');
        }
        await saveDifficultyProgress(env, progressState);
        // Verify it was saved by loading it back
        const verifyProgress = await loadDifficultyProgress(env);
        if (verifyProgress && verifyProgress.gamesWonAtCurrentDifficulty !== progressState.gamesWonAtCurrentDifficulty) {
          console.error('ERROR: Progress save verification failed!');
        }
      }
      
      return replyWithGame("", result.game);
    }
    return {
      content: [],
      structuredContent: {
        game: result.game || game,
        error: result.message || "Invalid move",
      },
    };
  };
  
  server.registerTool(
    "make_move",
    {
      title: "Make Move",
      description: "Makes a move in the game (place O on a player that matches the row category).",
      inputSchema: makeMoveInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Making move...",
        "openai/toolInvocation/invoked": "Move made!",
      },
    },
    makeMoveHandler
  );
  
  toolRegistry.set("make_move", {
    name: "make_move",
    definition: {
      title: "Make Move",
      description: "Makes a move in the game (place O on a player that matches the row category).",
      inputSchema: makeMoveInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Making move...",
        "openai/toolInvocation/invoked": "Move made!",
      },
    },
    handler: makeMoveHandler,
  });

  // Register ai_move tool
  const aiMoveHandler = async (args: any) => {
    const game = await getGame(env, args.gameId);
    if (!game) {
      return {
        content: [],
        structuredContent: { error: `Game ${args.gameId} not found.` },
      };
    }

    const result = gameEngine.makeAIMove(game);
    if (result.success) {
      await saveGame(env, result.game);
      
      // Save progress if game completed
      if (result.game.isComplete) {
        const progressState = gameEngine.getDifficultyState();
        await saveDifficultyProgress(env, progressState);
      }
      
      return replyWithGame("", result.game);
    }
    return {
      content: [],
      structuredContent: {
        game: result.game || game,
        error: result.message || "AI move failed",
      },
    };
  };
  
  server.registerTool(
    "ai_move",
    {
      title: "AI Move",
      description: "Has the AI make a move (places X).",
      inputSchema: aiMoveInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "AI is thinking...",
        "openai/toolInvocation/invoked": "AI made a move!",
      },
    },
    aiMoveHandler
  );
  
  toolRegistry.set("ai_move", {
    name: "ai_move",
    definition: {
      title: "AI Move",
      description: "Has the AI make a move (places X).",
      inputSchema: aiMoveInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "AI is thinking...",
        "openai/toolInvocation/invoked": "AI made a move!",
      },
    },
    handler: aiMoveHandler,
  });

  // Register guess_player tool
  const guessPlayerHandler = async (args: any) => {
    const game = await getGame(env, args.gameId);
    if (!game) {
      return {
        content: [],
        structuredContent: { error: `Game ${args.gameId} not found.` },
      };
    }

    const result = gameEngine.guessPlayer(game, args.row, args.col, args.playerName);
    await saveGame(env, result.game);

    if (result.success && !result.game.isComplete && result.game.currentTurn === 'ai') {
      // Make AI move after delay
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
      const aiResult = gameEngine.makeAIMove(result.game);
      await saveGame(env, aiResult.game);
      return replyWithGame("", aiResult.game);
    }
    return replyWithGame("", result.game);
  };
  
  server.registerTool(
    "guess_player",
    {
      title: "Guess Player",
      description: "Guess a player name for a specific cell in the game.",
      inputSchema: guessPlayerInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Checking guess...",
        "openai/toolInvocation/invoked": "Guess processed!",
      },
    },
    guessPlayerHandler
  );
  
  toolRegistry.set("guess_player", {
    name: "guess_player",
    definition: {
      title: "Guess Player",
      description: "Guess a player name for a specific cell in the game.",
      inputSchema: guessPlayerInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Checking guess...",
        "openai/toolInvocation/invoked": "Guess processed!",
      },
    },
    handler: guessPlayerHandler,
  });

  // Register skip_turn tool
  const skipTurnHandler = async (args: any) => {
    const game = await getGame(env, args.gameId);
    if (!game) {
      return {
        content: [],
        structuredContent: { error: `Game ${args.gameId} not found.` },
      };
    }

    if (game.isComplete || game.currentTurn !== 'user') {
      return replyWithGame("", game);
    }

    const gameWithAITurn = { ...game, currentTurn: 'ai' as const };
    const result = gameEngine.makeAIMove(gameWithAITurn);
    if (result.success) {
      await saveGame(env, result.game);
      return replyWithGame("", result.game);
    }
    return {
      content: [],
      structuredContent: {
        game: result.game || game,
        error: result.message || "AI move failed",
      },
    };
  };
  
  server.registerTool(
    "skip_turn",
    {
      title: "Skip Turn",
      description: "Skip your turn and let the AI make a move.",
      inputSchema: skipTurnInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Skipping turn...",
        "openai/toolInvocation/invoked": "Turn skipped!",
      },
    },
    skipTurnHandler
  );
  
  toolRegistry.set("skip_turn", {
    name: "skip_turn",
    definition: {
      title: "Skip Turn",
      description: "Skip your turn and let the AI make a move.",
      inputSchema: skipTurnInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/game-widget.html",
        "openai/toolInvocation/invoking": "Skipping turn...",
        "openai/toolInvocation/invoked": "Turn skipped!",
      },
    },
    handler: skipTurnHandler,
  });

  // Register search_players tool
  const searchPlayersHandler = async (args: any) => {
    const filters: Partial<PlayerRecord> = {};
    if (args.team) filters.Team = args.team;
    if (args.country) filters.Country = args.country;
    if (args.position) filters.Position = args.position;
    if (args.league) filters.League = args.league;

    const players = squadStore.search(filters);
    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${players.length} players matching your criteria.`,
        },
      ],
      structuredContent: { players },
    };
  };
  
  server.registerTool(
    "search_players",
    {
      title: "Search Players",
      description: "Search for players by team, country, position, or league.",
      inputSchema: searchPlayersInputSchema,
    },
    searchPlayersHandler
  );
  
  toolRegistry.set("search_players", {
    name: "search_players",
    definition: {
      title: "Search Players",
      description: "Search for players by team, country, position, or league.",
      inputSchema: searchPlayersInputSchema,
    },
    handler: searchPlayersHandler,
  });
  
    // Mark registry as populated
    registryPopulated = true;
  }

  return server;
}

// CORS headers helper
function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, mcp-session-id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

// MCP endpoint handler
async function handleMcpRequest(env: Env, request: Request): Promise<Response> {
  try {
    // Handle GET requests (no body) - return server info quickly
    if (request.method === "GET") {
      // Simple, fast response without creating MCP server
      // For GET requests without a request body, omit id field (JSON-RPC spec)
      const serverInfo: any = {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: {
            name: "rabona",
            version: "1.0.0",
          },
        },
      };
      
      // Always return JSON (SSE is deprecated)
      return new Response(JSON.stringify(serverInfo), {
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json",
        },
      });
    }

    // Handle POST/DELETE requests with body
    let body: any = null;
    try {
      const text = await request.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch (e) {
      // Empty body is OK for some MCP requests
      body = null;
    }

    // For initialize requests, respond immediately without creating server
    if (body?.method === "initialize") {
      const initResponse: any = {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
          },
          serverInfo: {
            name: "rabona",
            version: "1.0.0",
          },
        },
      };
      
      // Include id only if provided (string or number, not null)
      if (body.id !== null && body.id !== undefined) {
        initResponse.id = body.id;
      }
      
      // Always return JSON (SSE is deprecated)
      return new Response(JSON.stringify(initResponse), {
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json",
        },
      });
    }
    
    // Handle other MCP methods directly without transport
    // Ensure registry is populated (createMcpServer populates it, but we don't need the server for these requests)
    // Just create and discard the server to populate registry
    if (!registryPopulated) {
      createMcpServer(env, request);
    }
    
    // Handle initialized notification (no response needed per JSON-RPC spec)
    if (body?.method === "notifications/initialized") {
      // Notifications don't require a response, but we can return empty result
      const response: any = { jsonrpc: "2.0", result: null };
      if (body.id !== null && body.id !== undefined) {
        response.id = body.id;
      }
      return new Response(JSON.stringify(response), {
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json",
        },
      });
    }
    
    let result: any = null;
    let error: any = null;
    
    try {
      if (body?.method === "tools/list") {
        // Get tools from registry
        const tools: any[] = [];
        for (const [name, tool] of toolRegistry) {
          const toolDef: any = {
            name: tool.name,
            description: tool.definition.description || "",
            inputSchema: tool.definition.inputSchema || {},
          };
          // Include _meta if present (needed for widget outputTemplate)
          if (tool.definition._meta) {
            toolDef._meta = tool.definition._meta;
          }
          tools.push(toolDef);
        }
        result = { tools };
      } else if (body?.method === "resources/list") {
        // Get resources from registry
        const resources: any[] = [];
        for (const [name, resource] of resourceRegistry) {
          resources.push({
            uri: resource.uri,
            name: resource.name,
            description: resource.definition.description || "",
            mimeType: "text/html+skybridge",
          });
        }
        result = { resources };
      } else if (body?.method === "tools/call") {
        // Call tool directly from registry
        const toolName = body.params?.name;
        const toolArgs = body.params?.arguments || {};
        const tool = toolRegistry.get(toolName);
        
        if (!tool) {
          throw new Error(`Tool ${toolName} not found`);
        }
        
        const toolResult = await tool.handler(toolArgs);
        // Tool result should already have the correct format: { content: [], structuredContent: {...} }
        // Return it directly
        result = toolResult;
      } else if (body?.method === "resources/read") {
        // Read resource directly from registry
        const resourceUri = body.params?.uri;
        
        // Find resource by URI or name
        let resource: ResourceRegistry | undefined = undefined;
        for (const [name, res] of resourceRegistry) {
          if (res.uri === resourceUri || name === resourceUri) {
            resource = res;
            break;
          }
        }
        
        if (!resource) {
          throw new Error(`Resource ${resourceUri} not found`);
        }
        
        const resourceResult = await resource.handler({});
        result = resourceResult;
      } else {
        // Unknown method
        throw new Error(`Unknown MCP method: ${body.method}`);
      }
    } catch (methodError: any) {
      error = {
        code: -32603,
        message: methodError.message || "Internal server error",
      };
    }
    
    // Format response
    // JSON-RPC spec: id must be string, number, or omitted (not null)
    const response: any = error
      ? {
          jsonrpc: "2.0",
          error,
        }
      : {
          jsonrpc: "2.0",
          result,
        };
    
    // Include id only if it was provided in the request (string or number)
    if (body?.id !== null && body?.id !== undefined) {
      response.id = body.id;
    }
    
    // Always return JSON (SSE is deprecated)
    return new Response(JSON.stringify(response), {
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
      },
    });
  } catch (error: any) {
    console.error("Error handling MCP request:", error);
    console.error("Error details:", error.message);
    console.error("Stack:", error.stack);
    console.error("Request method:", request.method);
    console.error("Request URL:", request.url);
    
    // Try to get request body to extract id
    let requestId: string | number | undefined = undefined;
    try {
      const text = await request.clone().text();
      if (text) {
        const body = JSON.parse(text);
        if (body.id !== null && body.id !== undefined) {
          requestId = body.id;
        }
      }
    } catch (e) {
      // Ignore errors parsing body
    }
    
    const errorResponse: any = {
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error.message || "Internal server error",
      },
    };
    
    // Include id only if we have it
    if (requestId !== undefined) {
      errorResponse.id = requestId;
    }
    
    // Always return JSON (SSE is deprecated)
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
      },
    });
  }
}

// Main worker export
export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Health check
    if (method === "GET" && path === "/") {
      return new Response("Rabona MCP server", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Players endpoint
    if (method === "GET" && path === "/players") {
      const players = squadStore.getAll();
      return new Response(JSON.stringify({ count: players.length, players }), {
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json",
        },
      });
    }

    // MCP endpoint
    if ((method === "POST" || method === "GET" || method === "DELETE") && path === "/mcp") {
      return handleMcpRequest(env, request);
    }

    // OpenAI App adapter endpoint
    const adapterMatch = path.match(/^\/api\/mcp\/adapter-http\/([^/]+)$/);
    if (adapterMatch && (method === "POST" || method === "GET" || method === "DELETE")) {
      return handleMcpRequest(env, request);
    }

    // OpenAI Actions manifest
    if (method === "GET" && path === "/.well-known/openai-actions") {
      const serverUrl = url.origin;
      const tools = [
        {
          type: "function",
          function: {
            name: "create_game",
            description: "Creates a new tic-tac-toe game with soccer players.",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
        {
          type: "function",
          function: {
            name: "get_game",
            description: "Gets the current state of a game.",
            parameters: {
              type: "object",
              properties: {
                gameId: { type: "string", description: "The ID of the game to retrieve" },
              },
              required: ["gameId"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "make_move",
            description: "Makes a move in the game (place O on a player that matches the row category).",
            parameters: {
              type: "object",
              properties: {
                gameId: { type: "string" },
                row: { type: "number", minimum: 1, maximum: 3 },
                col: { type: "number", minimum: 1, maximum: 3 },
              },
              required: ["gameId", "row", "col"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "guess_player",
            description: "Guess a player name for a specific cell in the game.",
            parameters: {
              type: "object",
              properties: {
                gameId: { type: "string" },
                row: { type: "number", minimum: 1, maximum: 3 },
                col: { type: "number", minimum: 1, maximum: 3 },
                playerName: { type: "string" },
              },
              required: ["gameId", "row", "col", "playerName"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "skip_turn",
            description: "Skip your turn and let the AI make a move.",
            parameters: {
              type: "object",
              properties: { gameId: { type: "string" } },
              required: ["gameId"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "search_players",
            description: "Search for players by team, country, position, or league.",
            parameters: {
              type: "object",
              properties: {
                team: { type: "string" },
                country: { type: "string" },
                position: { type: "string" },
                league: { type: "string" },
              },
              required: [],
            },
          },
        },
      ];

      return new Response(
        JSON.stringify({
          serverUrl,
          tools,
          widgets: [
            {
              id: "game-widget",
              name: "Rabona Game",
              description: "Play tic-tac-toe with soccer players",
              url: "ui://widget/game-widget.html",
            },
          ],
        }),
        {
          headers: {
            ...corsHeaders(),
            "Content-Type": "application/json",
          },
        }
      );
    }

    // ChatGPT tool execution endpoint
    const toolMatch = path.match(/^\/([^/]+)\/link_([^/]+)\/([^/]+)$/);
    if (toolMatch && method === "POST") {
      const [, appName, linkId, toolName] = toolMatch;
      const args = await request.json().catch(() => ({}));

      try {
        const mcpRequest = {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: toolName, arguments: args },
        };

        const mcpServer = createMcpServer(env, request);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        await mcpServer.connect(transport);

        // Create a response handler
        let toolResult: any = null;
        let responseHeaders: Record<string, string> = {};
        const mockRes = {
          setHeader: (name: string, value: string) => {
            responseHeaders[name] = value;
          },
          getHeader: (name: string) => responseHeaders[name],
          writeHead: (status: number, headers?: any) => {
            if (headers) {
              Object.assign(responseHeaders, headers);
            }
          },
          write: (chunk: any) => {
            if (!toolResult) toolResult = '';
            toolResult += typeof chunk === 'string' ? chunk : chunk.toString();
          },
          end: (chunk?: any) => {
            if (chunk) {
              if (!toolResult) toolResult = '';
              toolResult += typeof chunk === 'string' ? chunk : chunk.toString();
            }
            try {
              if (toolResult && typeof toolResult === 'string') {
                toolResult = JSON.parse(toolResult);
              }
            } catch (e) {
              // Not JSON, keep as string
            }
          },
          status: () => mockRes,
          json: (data: any) => {
            toolResult = data;
          },
          send: (data: any) => {
            toolResult = data;
          },
          on: () => {},
          headersSent: false,
        } as any;

        await transport.handleRequest(request as any, mockRes, mcpRequest);
        
        // Extract result from MCP response format
        if (toolResult?.result) {
          toolResult = toolResult.result;
        }

        return new Response(
          JSON.stringify(
            toolResult.content !== undefined
              ? toolResult
              : { content: [], structuredContent: toolResult }
          ),
          {
            headers: {
              ...corsHeaders(),
              "Content-Type": "application/json",
            },
          }
        );
      } catch (error: any) {
        return new Response(
          JSON.stringify({
            content: [],
            structuredContent: {
              error: "Tool execution failed",
              message: error.message,
            },
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders(),
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    // Try to serve static assets
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }

    return new Response("Not Found", { status: 404 });
  },
};

// Export Durable Object
export { GameStore };


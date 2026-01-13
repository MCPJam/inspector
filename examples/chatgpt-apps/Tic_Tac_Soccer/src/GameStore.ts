import type { Game } from "./GameEngine.js";
import type { DurableObjectState } from "@cloudflare/workers-types";

/**
 * Durable Object for storing game state
 * Each game gets its own instance for persistent state
 */
export class GameStore {
  private state: DurableObjectState;
  private game: Game | null = null;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Get game state
    if (method === "GET" && path === "/") {
      // Try to load from storage first
      if (!this.game) {
        const stored = await this.state.storage.get<Game>("game");
        if (stored) {
          this.game = stored;
        }
      }
      
      if (!this.game) {
        return Response.json({ game: null }, { status: 404 });
      }
      return Response.json({ game: this.game });
    }

    // Set game state
    if (method === "PUT" && path === "/") {
      const body = await request.json();
      this.game = body.game as Game;
      await this.state.storage.put("game", this.game);
      return Response.json({ success: true, game: this.game });
    }

    // Delete game
    if (method === "DELETE" && path === "/") {
      this.game = null;
      await this.state.storage.delete("game");
      return Response.json({ success: true });
    }

    // Get progress (for user_progress Durable Object)
    if (method === "GET" && path === "/progress") {
      const stored = await this.state.storage.get<any>("progress");
      if (stored) {
        return Response.json({ progress: stored });
      }
      return Response.json({ progress: null }, { status: 404 });
    }

    // Set progress (for user_progress Durable Object)
    if (method === "PUT" && path === "/progress") {
      const body = await request.json();
      await this.state.storage.put("progress", body.progress);
      return Response.json({ success: true, progress: body.progress });
    }

    return new Response("Not Found", { status: 404 });
  }
}


/**
 * Type definitions for OpenAI App SDK
 */

export interface Widget {
  id: string;
  name: string;
  description: string;
  url: string;
  width?: number;
  height?: number;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (params: Record<string, any>) => Promise<any>;
}

export interface ServerConfig {
  port: number;
  host?: string;
  cors?: boolean;
  squadDataPath?: string;
}

export interface OpenAIAction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface PlayerRecord {
  Name: string;
  Team: string;
  Country: string;
  Position: string;
  League: string;
  'Shirt Number'?: string;
  Priority?: string | number; // Priority/Difficulty: 1 = easy/famous, 2 = medium, 3 = hard/less famous
}

// Game types are exported from GameEngine.ts
export type { Game, GameCell, CellMark, CategoryType } from './GameEngine.js';


import { parse } from 'csv-parse/sync';
import type { PlayerRecord } from './types.js';

/**
 * SquadStore for Cloudflare Workers
 * Accepts CSV data as a string (bundled at build time)
 */
export class SquadStoreWorker {
  private players: PlayerRecord[] = [];

  constructor(csvData: string) {
    this.load(csvData);
  }

  /**
   * Load player data from CSV string into memory.
   */
  load(csvData: string): void {
    try {
      if (!csvData || csvData.trim().length === 0) {
        console.warn('⚠️  No CSV data provided');
        this.players = [];
        return;
      }

      const records = parse(csvData, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];

      const normalized = records.map((record) => {
        const normalizedEntries = Object.entries(record).map(([key, value]) => {
          const cleanKey = key.replace(/^\ufeff/, '').trim();
          return [cleanKey, typeof value === 'string' ? value.trim() : value];
        });
        return Object.fromEntries(normalizedEntries) as PlayerRecord;
      });

      this.players = normalized.filter(
        (record) =>
          record.Name &&
          record.Team &&
          record.Country &&
          record.Position &&
          record.League,
      );
      console.log(`✓ Loaded ${this.players.length} players from bundled CSV`);
    } catch (error: any) {
      console.warn(`⚠️  Could not parse CSV data. Reason: ${error.message}`);
      this.players = [];
    }
  }

  /**
   * Get all players.
   */
  getAll(): PlayerRecord[] {
    return this.players;
  }

  /**
   * Simple search with partial matching for any field.
   */
  search(filters: Partial<PlayerRecord>): PlayerRecord[] {
    if (Object.keys(filters).length === 0) {
      return this.players;
    }

    return this.players.filter((player) => {
      return Object.entries(filters).every(([key, value]) => {
        if (!value) {
          return true;
        }
        const fieldValue = player[key as keyof PlayerRecord];
        if (!fieldValue) {
          return false;
        }

        return String(fieldValue).toLowerCase().includes(String(value).toLowerCase());
      });
    });
  }
}






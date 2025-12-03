import Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";
import type { RegistryServer } from "@/shared/types";

/**
 * Fuse.js configuration for registry server search
 */
const fuseOptions: IFuseOptions<RegistryServer> = {
  // Fields to search with their respective weights
  keys: [
    { name: "name", weight: 2.0 }, // Highest priority - server name
    { name: "description", weight: 1.0 }, // Medium priority - description
    { name: "packages.identifier", weight: 0.8 }, // Package names
    { name: "packages.registryType", weight: 0.5 }, // Package types (npm, pypi, etc)
    { name: "_meta.tags", weight: 0.6 }, // Tags if available
  ],
  // Fuzzy matching threshold (0.0 = exact, 1.0 = match anything)
  // 0.4 allows more flexible matching for partial words in long names
  threshold: 0.4,
  // Include score in results for sorting by relevance
  includeScore: true,
  // Include matched indices for highlighting (future enhancement)
  includeMatches: false,
  // Minimum characters before matching
  minMatchCharLength: 2,
  // Search in all locations (not just beginning)
  findAllMatches: true,
  // Use extended search for special operators (future: support "^term", "!term", etc)
  useExtendedSearch: false,
  // Important: Set distance to allow matching substrings in longer strings
  distance: 1000,
  // Ignore location for better substring matching
  ignoreLocation: true,
};

/**
 * Creates a Fuse instance for searching registry servers
 */
export function createRegistrySearch(servers: RegistryServer[]) {
  return new Fuse(servers, fuseOptions);
}

/**
 * Parse search query for special operators
 * Examples:
 *   "openai" -> { query: "openai" }
 *   "official:true npm" -> { query: "npm", filters: { official: true } }
 *   "type:npm slack" -> { query: "slack", filters: { packageType: "npm" } }
 */
export function parseSearchQuery(input: string): {
  query: string;
  filters: {
    official?: boolean;
    hasRemote?: boolean;
    packageType?: string;
    status?: string;
  };
} {
  const filters: {
    official?: boolean;
    hasRemote?: boolean;
    packageType?: string;
    status?: string;
  } = {};

  let query = input;

  // Extract official: filter
  const officialMatch = query.match(/official:(true|false)/i);
  if (officialMatch) {
    filters.official = officialMatch[1].toLowerCase() === "true";
    query = query.replace(officialMatch[0], "").trim();
  }

  // Extract type: filter (package type)
  const typeMatch = query.match(/type:(\w+)/i);
  if (typeMatch) {
    filters.packageType = typeMatch[1].toLowerCase();
    query = query.replace(typeMatch[0], "").trim();
  }

  // Extract remote: filter
  const remoteMatch = query.match(/remote:(true|false)/i);
  if (remoteMatch) {
    filters.hasRemote = remoteMatch[1].toLowerCase() === "true";
    query = query.replace(remoteMatch[0], "").trim();
  }

  // Extract status: filter
  const statusMatch = query.match(/status:(\w+)/i);
  if (statusMatch) {
    filters.status = statusMatch[1].toLowerCase();
    query = query.replace(statusMatch[0], "").trim();
  }

  return { query: query.trim(), filters };
}

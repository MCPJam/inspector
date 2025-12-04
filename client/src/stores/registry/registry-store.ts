import { createStore } from "zustand/vanilla";
import type { RegistryServer } from "@/shared/types";
import { listRegistryServers } from "@/lib/apis/registry-api";
import { toast } from "sonner";

const CACHE_KEY = "mcp-registry-cache";
const CACHE_TIMESTAMP_KEY = "mcp-registry-cache-timestamp";
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export type RegistryState = {
  allServers: RegistryServer[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | undefined;
  isFullyLoaded: boolean;
  lastFetchTime: number | null;
  isRefreshing: boolean;
  fetchServers: (cursor?: string) => Promise<void>;
  fetchAllPages: (forceRefresh?: boolean) => void;
  reset: () => void;
};

const initialState = {
  allServers: [],
  loading: false,
  error: null,
  hasMore: false,
  nextCursor: undefined,
  isFullyLoaded: false,
  lastFetchTime: null,
  isRefreshing: false,
};

// Load cached data from localStorage
const loadCachedData = (): {
  servers: RegistryServer[];
  timestamp: number;
} | null => {
  try {
    const cachedServers = localStorage.getItem(CACHE_KEY);
    const cachedTimestamp = localStorage.getItem(CACHE_TIMESTAMP_KEY);

    if (!cachedServers || !cachedTimestamp) {
      return null;
    }

    const timestamp = parseInt(cachedTimestamp, 10);
    const now = Date.now();

    // Check if cache is still valid (within 24 hours)
    if (now - timestamp > CACHE_DURATION) {
      // Cache expired, clear it
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(CACHE_TIMESTAMP_KEY);
      return null;
    }

    const servers = JSON.parse(cachedServers) as RegistryServer[];
    return { servers, timestamp };
  } catch (err) {
    console.error("Error loading cached registry data:", err);
    return null;
  }
};

// Save data to localStorage cache
const saveCachedData = (servers: RegistryServer[]) => {
  try {
    const timestamp = Date.now();
    localStorage.setItem(CACHE_KEY, JSON.stringify(servers));
    localStorage.setItem(CACHE_TIMESTAMP_KEY, timestamp.toString());
  } catch (err) {
    console.error("Error saving registry data to cache:", err);
  }
};

export const createRegistryStore = () => {
  // Try to load cached data on store creation
  const cachedData = loadCachedData();
  const initialStateWithCache = cachedData
    ? {
        ...initialState,
        allServers: cachedData.servers,
        isFullyLoaded: true,
        lastFetchTime: cachedData.timestamp,
      }
    : initialState;

  return createStore<RegistryState>()((set, get) => ({
    ...initialStateWithCache,

    fetchServers: async (cursor?: string) => {
      const state = get();

      // Don't fetch if already loading
      if (state.loading) return;

      set({ loading: true, error: null });

      try {
        const response = await listRegistryServers({
          limit: 100,
          cursor,
        });

        // Unwrap servers from the wrapper structure
        const unwrappedServers = response.servers.map((wrapper) => ({
          ...wrapper.server,
          _meta: { ...wrapper.server._meta, ...wrapper._meta },
        }));

        set((state) => {
          if (cursor) {
            // Append to existing servers for pagination, avoiding duplicates
            const existingIds = new Set(
              state.allServers.map((s) => `${s.name}@${s.version}`),
            );
            const newServers = unwrappedServers.filter(
              (s) => !existingIds.has(`${s.name}@${s.version}`),
            );
            return {
              allServers: [...state.allServers, ...newServers],
              nextCursor: response.metadata.nextCursor,
              hasMore: !!response.metadata.nextCursor,
              loading: false,
            };
          } else {
            // Replace servers for initial load
            return {
              allServers: unwrappedServers,
              nextCursor: response.metadata.nextCursor,
              hasMore: !!response.metadata.nextCursor,
              loading: false,
            };
          }
        });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to load registry servers";
        set({ error: message, loading: false });
        toast.error(message);
      }
    },

    fetchAllPages: (forceRefresh = false) => {
      const state = get();

      // Check if we need to fetch
      if (!forceRefresh) {
        // If we have cached data and it's fully loaded, skip fetching
        if (state.isFullyLoaded && state.allServers.length > 0) {
          return;
        }
      }

      // If already loading or refreshing, don't start another fetch
      if (state.loading || state.isRefreshing) return;

      // For initial load (no cached data), show loading spinner
      if (state.allServers.length === 0) {
        set({ loading: true, error: null });
      } else {
        // For refresh with existing data, set refreshing flag
        set({ isRefreshing: true, error: null });
      }

      // Start background fetch - don't await it!
      (async () => {
        try {
          const newServers: RegistryServer[] = [];
          let cursor: string | undefined = undefined;
          let hasMore = true;

          // Fetch all pages
          while (hasMore) {
            const response = await listRegistryServers({
              limit: 100,
              cursor,
            });

            // Unwrap servers from the wrapper structure
            const unwrappedServers = response.servers.map((wrapper) => ({
              ...wrapper.server,
              _meta: { ...wrapper.server._meta, ...wrapper._meta },
            }));

            newServers.push(...unwrappedServers);
            cursor = response.metadata.nextCursor;
            hasMore = !!cursor;
          }

          // Deduplicate servers
          const uniqueServers = Array.from(
            new Map(
              newServers.map((s) => [`${s.name}@${s.version}`, s]),
            ).values(),
          );

          // Only update state after ALL pages are loaded
          set({
            allServers: uniqueServers,
            isFullyLoaded: true,
            lastFetchTime: Date.now(),
            loading: false,
            isRefreshing: false,
            error: null,
          });

          // Save to cache
          saveCachedData(uniqueServers);
        } catch (err) {
          console.error("Error fetching registry servers:", err);
          const message =
            err instanceof Error
              ? err.message
              : "Failed to load registry servers";

          const currentState = get();

          // If we have cached data, keep it and just show error for refresh
          if (currentState.allServers.length > 0) {
            set({
              loading: false,
              isRefreshing: false,
              // Don't set error if we have cached data - just silently fail
            });

            // Show a subtle toast that refresh failed but we're using cached data
            toast.warning("Using cached data - refresh failed", {
              description: "Unable to fetch latest registry data",
            });
          } else {
            // No cached data available, show error
            set({
              error: message,
              loading: false,
              isRefreshing: false,
              // Mark as loaded even on error to prevent infinite retries
              isFullyLoaded: false,
            });

            toast.error(message);
          }
        }
      })();
    },

    reset: () => set(initialState),
  }));
};

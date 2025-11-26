import { createStore } from "zustand/vanilla";
import type { RegistryServer } from "@/shared/types";
import { listRegistryServers, isAuthRequired } from "@/lib/registry-api";
import { toast } from "sonner";

const CACHE_KEY_PREFIX = "mcp-registry-cache";
const CACHE_TIMESTAMP_KEY_PREFIX = "mcp-registry-cache-timestamp";
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1";

// Generate cache keys based on registry URL
function getCacheKey(registryUrl: string): string {
  // Use a hash-like identifier for the registry URL
  const urlId = btoa(registryUrl).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  return `${CACHE_KEY_PREFIX}-${urlId}`;
}

function getCacheTimestampKey(registryUrl: string): string {
  const urlId = btoa(registryUrl).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  return `${CACHE_TIMESTAMP_KEY_PREFIX}-${urlId}`;
}

export type RegistryState = {
  allServers: RegistryServer[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | undefined;
  isFullyLoaded: boolean;
  lastFetchTime: number | null;
  isRefreshing: boolean;
  currentRegistryUrl: string | null;
  authRequired: boolean;
  fetchServers: (cursor?: string, registryUrl?: string) => Promise<void>;
  fetchAllPages: (forceRefresh?: boolean, registryUrl?: string) => void;
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
  currentRegistryUrl: null,
  authRequired: false,
};

// Load cached data from localStorage for a specific registry
const loadCachedData = (
  registryUrl: string,
): {
  servers: RegistryServer[];
  timestamp: number;
} | null => {
  try {
    const cacheKey = getCacheKey(registryUrl);
    const timestampKey = getCacheTimestampKey(registryUrl);

    const cachedServers = localStorage.getItem(cacheKey);
    const cachedTimestamp = localStorage.getItem(timestampKey);

    if (!cachedServers || !cachedTimestamp) {
      return null;
    }

    const timestamp = parseInt(cachedTimestamp, 10);
    const now = Date.now();

    // Check if cache is still valid (within 24 hours)
    if (now - timestamp > CACHE_DURATION) {
      // Cache expired, clear it
      localStorage.removeItem(cacheKey);
      localStorage.removeItem(timestampKey);
      return null;
    }

    const servers = JSON.parse(cachedServers) as RegistryServer[];
    return { servers, timestamp };
  } catch (err) {
    console.error("Error loading cached registry data:", err);
    return null;
  }
};

// Save data to localStorage cache for a specific registry
const saveCachedData = (servers: RegistryServer[], registryUrl: string) => {
  try {
    const cacheKey = getCacheKey(registryUrl);
    const timestampKey = getCacheTimestampKey(registryUrl);

    const timestamp = Date.now();
    localStorage.setItem(cacheKey, JSON.stringify(servers));
    localStorage.setItem(timestampKey, timestamp.toString());
  } catch (err) {
    console.error("Error saving registry data to cache:", err);
  }
};

export const createRegistryStore = () => {
  // Try to load cached data for the default registry on store creation
  const cachedData = loadCachedData(DEFAULT_REGISTRY_URL);
  const initialStateWithCache = cachedData
    ? {
        ...initialState,
        allServers: cachedData.servers,
        isFullyLoaded: true,
        lastFetchTime: cachedData.timestamp,
        currentRegistryUrl: DEFAULT_REGISTRY_URL,
      }
    : {
        ...initialState,
        currentRegistryUrl: DEFAULT_REGISTRY_URL,
      };

  return createStore<RegistryState>()((set, get) => ({
    ...initialStateWithCache,

    fetchServers: async (cursor?: string, registryUrl?: string) => {
      const state = get();
      const targetUrl = registryUrl || state.currentRegistryUrl || DEFAULT_REGISTRY_URL;

      // Don't fetch if already loading
      if (state.loading) return;

      set({ loading: true, error: null, authRequired: false });

      try {
        const response = await listRegistryServers({
          limit: 100,
          cursor,
          registryUrl: targetUrl,
        });

        // Check if auth is required
        if (isAuthRequired(response)) {
          set({
            loading: false,
            authRequired: true,
            error: "Authentication required for this registry",
          });
          return;
        }

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
              currentRegistryUrl: targetUrl,
            };
          } else {
            // Replace servers for initial load
            return {
              allServers: unwrappedServers,
              nextCursor: response.metadata.nextCursor,
              hasMore: !!response.metadata.nextCursor,
              loading: false,
              currentRegistryUrl: targetUrl,
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

    fetchAllPages: (forceRefresh = false, registryUrl?: string) => {
      const state = get();
      const targetUrl = registryUrl || state.currentRegistryUrl || DEFAULT_REGISTRY_URL;

      // If registry URL changed, always refetch
      const registryChanged = targetUrl !== state.currentRegistryUrl;

      // Check if we need to fetch
      if (!forceRefresh && !registryChanged) {
        // If we have cached data and it's fully loaded, skip fetching
        if (state.isFullyLoaded && state.allServers.length > 0) {
          return;
        }
      }

      // If already loading or refreshing, don't start another fetch
      if (state.loading || state.isRefreshing) return;

      // Try to load cached data for this registry URL
      const cachedData = loadCachedData(targetUrl);

      // If we have valid cached data for this registry and not force refresh
      if (cachedData && !forceRefresh) {
        set({
          allServers: cachedData.servers,
          isFullyLoaded: true,
          lastFetchTime: cachedData.timestamp,
          currentRegistryUrl: targetUrl,
          loading: false,
          isRefreshing: false,
          authRequired: false,
        });
        return;
      }

      // For initial load (no cached data), show loading spinner
      if (state.allServers.length === 0 || registryChanged) {
        set({
          loading: true,
          error: null,
          authRequired: false,
          currentRegistryUrl: targetUrl,
          // Clear servers when switching registries
          ...(registryChanged ? { allServers: [], isFullyLoaded: false } : {}),
        });
      } else {
        // For refresh with existing data, set refreshing flag
        set({ isRefreshing: true, error: null, authRequired: false });
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
              registryUrl: targetUrl,
            });

            // Check if auth is required
            if (isAuthRequired(response)) {
              set({
                loading: false,
                isRefreshing: false,
                authRequired: true,
                error: "Authentication required for this registry",
                currentRegistryUrl: targetUrl,
                allServers: [],
                isFullyLoaded: false,
              });
              return;
            }

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
            currentRegistryUrl: targetUrl,
            authRequired: false,
          });

          // Save to cache
          saveCachedData(uniqueServers, targetUrl);
        } catch (err) {
          console.error("Error fetching registry servers:", err);
          const message =
            err instanceof Error
              ? err.message
              : "Failed to load registry servers";

          const currentState = get();

          // If we have cached data, keep it and just show error for refresh
          if (currentState.allServers.length > 0 && !registryChanged) {
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
              currentRegistryUrl: targetUrl,
            });

            toast.error(message);
          }
        }
      })();
    },

    reset: () => set(initialState),
  }));
};

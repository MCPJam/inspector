import { useState, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ServerCard } from "./registry/ServerCard";
import { ServerDetailModal } from "./registry/ServerDetailModal";
import { SearchInput } from "./ui/search-input";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";
import { Loader2, Package, RefreshCw } from "lucide-react";
import type { RegistryServer, ServerFormData } from "@/shared/types";
import { AddServerModal } from "./connection/AddServerModal";
import { parseSearchQuery, createRegistrySearch } from "@/lib/registry-search";
import { useRegistryStore } from "@/stores/registry/registry-provider";

interface RegistryTabProps {
  onConnect: (formData: ServerFormData) => void;
}

export function RegistryTab({ onConnect }: RegistryTabProps) {
  // Get data from the registry store
  const allServers = useRegistryStore((state) => state.allServers);
  const loading = useRegistryStore((state) => state.loading);
  const error = useRegistryStore((state) => state.error);
  const isFullyLoaded = useRegistryStore((state) => state.isFullyLoaded);
  const lastFetchTime = useRegistryStore((state) => state.lastFetchTime);
  const isRefreshing = useRegistryStore((state) => state.isRefreshing);
  const fetchAllPages = useRegistryStore((state) => state.fetchAllPages);

  // Local state
  const [searchQuery, setSearchQuery] = useState("");

  // Modal state
  const [isAddServerModalOpen, setIsAddServerModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedServer, setSelectedServer] = useState<RegistryServer | null>(null);

  // Ref for the scrollable container
  const parentRef = useRef<HTMLDivElement>(null);

  // Determine columns per row based on container width
  const [columnsPerRow, setColumnsPerRow] = useState(3);

  // Filter to show only the latest version of each server
  const latestServers = useMemo(() => {
    return allServers.filter((server) => {
      const isLatest = server._meta?.['io.modelcontextprotocol.registry/official']?.isLatest;
      return isLatest === true;
    });
  }, [allServers]);

  // Memoize the Fuse.js instance to avoid recreating it on every render
  const fuseInstance = useMemo(() => {
    if (latestServers.length === 0) return null;
    return createRegistrySearch(latestServers);
  }, [latestServers]);

  // Use Fuse.js for client-side search with memoization
  const filteredServers = useMemo(() => {
    // No search query - return all servers sorted alphabetically
    if (!searchQuery.trim()) {
      return [...latestServers].sort((a, b) =>
        (a.name || '').localeCompare(b.name || '')
      );
    }

    const { query, filters } = parseSearchQuery(searchQuery);
    let results = latestServers;

    // Apply filters first
    if (filters && Object.keys(filters).length > 0) {
      results = results.filter((server) => {
        if (filters.official !== undefined && server._meta?.official !== filters.official) {
          return false;
        }
        if (filters.hasRemote !== undefined) {
          const hasRemote = server.remotes && server.remotes.length > 0;
          if (hasRemote !== filters.hasRemote) {
            return false;
          }
        }
        if (filters.packageType) {
          const hasPackageType = server.packages?.some(
            (pkg) => pkg.registryType === filters.packageType
          );
          if (!hasPackageType) {
            return false;
          }
        }
        if (filters.status && server.status !== filters.status) {
          return false;
        }
        return true;
      });
    }

    // If no query text, return filtered results
    if (!query.trim()) {
      return results.sort((a, b) =>
        (a.name || '').localeCompare(b.name || '')
      );
    }

    // Use the memoized Fuse instance for search
    if (!fuseInstance) return results;

    const searchResults = fuseInstance.search(query);
    const searchedItems = searchResults.map((result) => result.item);

    // Apply filters to search results
    if (filters && Object.keys(filters).length > 0) {
      return searchedItems.filter((server) => {
        if (filters.official !== undefined && server._meta?.official !== filters.official) {
          return false;
        }
        if (filters.hasRemote !== undefined) {
          const hasRemote = server.remotes && server.remotes.length > 0;
          if (hasRemote !== filters.hasRemote) {
            return false;
          }
        }
        if (filters.packageType) {
          const hasPackageType = server.packages?.some(
            (pkg) => pkg.registryType === filters.packageType
          );
          if (!hasPackageType) {
            return false;
          }
        }
        if (filters.status && server.status !== filters.status) {
          return false;
        }
        return true;
      });
    }

    return searchedItems;
  }, [allServers, searchQuery, fuseInstance]);

  // Group servers into rows for virtualization
  const serverRows = useMemo(() => {
    const rows: RegistryServer[][] = [];
    for (let i = 0; i < filteredServers.length; i += columnsPerRow) {
      rows.push(filteredServers.slice(i, i + columnsPerRow));
    }
    return rows;
  }, [filteredServers, columnsPerRow]);

  // Create row virtualizer
  const rowVirtualizer = useVirtualizer({
    count: serverRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280, // Estimated height of a server card row
    overscan: 2, // Render 2 extra rows above and below viewport
  });

  const handleSearch = (value: string) => {
    setSearchQuery(value);
  };

  const handleRefresh = () => {
    fetchAllPages(true); // Force refresh
  };

  // Format last update time
  const getLastUpdateText = () => {
    if (!lastFetchTime) return null;

    const now = Date.now();
    const diffMs = now - lastFetchTime;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 1) return "Updated just now";
    if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`;
    if (diffHours < 24) return `Updated ${diffHours}h ago`;
    return `Updated ${Math.floor(diffHours / 24)}d ago`;
  };

  const handleInstall = (server: RegistryServer) => {
    setSelectedServer(server);
    setIsDetailModalOpen(false); // Close detail modal if open
    setIsAddServerModalOpen(true);
  };

  const handleViewDetails = (server: RegistryServer) => {
    setSelectedServer(server);
    setIsDetailModalOpen(true);
  };

  const handleAddServer = (formData: ServerFormData) => {
    onConnect(formData);
    setIsAddServerModalOpen(false);
    setSelectedServer(null);
  };

  // Convert registry server to form data
  const getPrefilledFormData = (): Partial<ServerFormData> | undefined => {
    if (!selectedServer || !selectedServer.name) return undefined;

    const formData: Partial<ServerFormData> = {
      name: selectedServer.name.split("/").pop() || selectedServer.name,
    };

    // Check if it has npm package
    const npmPackage = selectedServer.packages?.find(
      (pkg) => pkg.registryType === "npm"
    );
    if (npmPackage) {
      formData.type = "stdio";
      formData.command = "npx";
      formData.args = ["-y", npmPackage.identifier];
      return formData;
    }

    // Check if it has remote connection
    const remote = selectedServer.remotes?.[0];
    if (remote) {
      if (remote.type === "stdio" && remote.command) {
        formData.type = "stdio";
        formData.command = remote.command;
        formData.args = remote.args;
        formData.env = remote.env;
        return formData;
      }
      if (remote.url) {
        formData.type = "http";
        formData.url = remote.url;

        // Auto-configure OAuth 2.0 for streamable-http and SSE transports
        if (
          remote.type === "streamable-http" ||
          remote.type === "streamableHttp" ||
          remote.type === "sse"
        ) {
          formData.useOAuth = true;
        }

        return formData;
      }
    }

    return formData;
  };

  if (!isFullyLoaded && allServers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading registry servers...</p>
        </div>
      </div>
    );
  }

  if (error && allServers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <EmptyState
          icon={Package}
          title="Failed to Load Registry"
          description={error}
          action={
            <Button onClick={handleRefresh} variant="outline">
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with search */}
      <div className="border-b border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">MCP Server Registry</h2>
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">
                Discover and install official MCP servers
              </p>
              {getLastUpdateText() && (
                <>
                  <span className="text-sm text-muted-foreground">•</span>
                  <p className="text-xs text-muted-foreground">
                    {getLastUpdateText()}
                  </p>
                </>
              )}
            </div>
          </div>
          <Button onClick={handleRefresh} variant="outline" size="sm" disabled={isRefreshing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        <SearchInput
          placeholder="Search servers..."
          value={searchQuery}
          onValueChange={handleSearch}
          className="max-w-md"
        />
      </div>

      {/* Server grid */}
      <div ref={parentRef} className="flex-1 overflow-auto p-4">
        {filteredServers.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No Servers Found"
            description={
              searchQuery
                ? "Try adjusting your search query"
                : "No servers available in the registry"
            }
          />
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const serversInRow = serverRows[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {serversInRow.map((server, colIndex) => (
                      <ServerCard
                        key={`${server.name || 'unknown'}-${server.version || 'unknown'}-${virtualRow.index}-${colIndex}`}
                        server={server}
                        onInstall={handleInstall}
                        onViewDetails={handleViewDetails}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Server Detail Modal */}
      <ServerDetailModal
        server={selectedServer}
        isOpen={isDetailModalOpen}
        onClose={() => {
          setIsDetailModalOpen(false);
          setSelectedServer(null);
        }}
        onInstall={handleInstall}
      />

      {/* Add Server Modal - pre-filled with registry data */}
      <AddServerModal
        isOpen={isAddServerModalOpen}
        onClose={() => {
          setIsAddServerModalOpen(false);
          setSelectedServer(null);
        }}
        onSubmit={handleAddServer}
        initialData={selectedServer ? getPrefilledFormData() : undefined}
      />
    </div>
  );
}

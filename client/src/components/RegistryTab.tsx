import { useEffect, useState, useMemo } from "react";
import { ServerCard } from "./registry/ServerCard";
import { ServerDetailModal } from "./registry/ServerDetailModal";
import { SearchInput } from "./ui/search-input";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";
import { Loader2, Package, RefreshCw } from "lucide-react";
import type { RegistryServer, ServerFormData } from "@/shared/types";
import { listRegistryServers } from "@/lib/registry-api";
import { AddServerModal } from "./connection/AddServerModal";
import { toast } from "sonner";
import { searchRegistryServers, parseSearchQuery } from "@/lib/registry-search";

interface RegistryTabProps {
  onConnect: (formData: ServerFormData) => void;
}

export function RegistryTab({ onConnect }: RegistryTabProps) {
  const [allServers, setAllServers] = useState<RegistryServer[]>([]); // All fetched servers
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Modal state
  const [isAddServerModalOpen, setIsAddServerModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedServer, setSelectedServer] = useState<RegistryServer | null>(null);

  const fetchServers = async (cursor?: string) => {
    try {
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);

      const response = await listRegistryServers({
        limit: 100, // Max allowed by the registry API
        cursor,
      });

      // Unwrap servers from the wrapper structure
      const unwrappedServers = response.servers.map((wrapper) => ({
        ...wrapper.server,
        _meta: { ...wrapper.server._meta, ...wrapper._meta },
      }));

      if (cursor) {
        // Append to existing servers for pagination, avoiding duplicates
        setAllServers((prev) => {
          const existingIds = new Set(prev.map(s => `${s.name}@${s.version}`));
          const newServers = unwrappedServers.filter(
            s => !existingIds.has(`${s.name}@${s.version}`)
          );
          return [...prev, ...newServers];
        });
      } else {
        // Replace servers for initial load
        setAllServers(unwrappedServers);
      }

      setNextCursor(response.metadata.nextCursor);
      setHasMore(!!response.metadata.nextCursor);

      // Auto-fetch all pages on initial load for better search experience
      if (!cursor && response.metadata.nextCursor) {
        // Recursively fetch remaining pages in background
        fetchAllRemainingPages(response.metadata.nextCursor);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load registry servers";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  // Fetch all remaining pages in the background
  const fetchAllRemainingPages = async (cursor: string) => {
    try {
      const response = await listRegistryServers({
        limit: 100,
        cursor,
      });

      const unwrappedServers = response.servers.map((wrapper) => ({
        ...wrapper.server,
        _meta: { ...wrapper.server._meta, ...wrapper._meta },
      }));

      // Deduplicate servers before adding
      setAllServers((prev) => {
        const existingIds = new Set(prev.map(s => `${s.name}@${s.version}`));
        const newServers = unwrappedServers.filter(
          s => !existingIds.has(`${s.name}@${s.version}`)
        );
        return [...prev, ...newServers];
      });

      setNextCursor(response.metadata.nextCursor);
      setHasMore(!!response.metadata.nextCursor);

      // Continue fetching if there are more pages
      if (response.metadata.nextCursor) {
        fetchAllRemainingPages(response.metadata.nextCursor);
      }
    } catch (err) {
      console.error("Error fetching additional pages:", err);
      // Don't show error toast for background fetches
    }
  };

  // Use Fuse.js for client-side search with memoization
  const filteredServers = useMemo(() => {
    if (!searchQuery.trim()) {
      return allServers;
    }

    const { query, filters } = parseSearchQuery(searchQuery);
    return searchRegistryServers(allServers, query, filters);
  }, [allServers, searchQuery]);

  useEffect(() => {
    fetchServers();
  }, []);

  const handleSearch = (value: string) => {
    setSearchQuery(value);
  };

  const handleLoadMore = () => {
    if (nextCursor && !loadingMore) {
      fetchServers(nextCursor);
    }
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
        return formData;
      }
    }

    return formData;
  };

  if (loading && allServers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading registry...</p>
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
            <Button onClick={() => fetchServers()} variant="outline">
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
            <p className="text-sm text-muted-foreground">
              Discover and install official MCP servers
            </p>
          </div>
          <Button onClick={() => fetchServers()} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
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
      <div className="flex-1 overflow-auto p-4">
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredServers.map((server, index) => (
              <ServerCard
                key={`${server.name || 'unknown'}-${server.version || 'unknown'}-${index}`}
                server={server}
                onInstall={handleInstall}
                onViewDetails={handleViewDetails}
              />
            ))}
          </div>
        )}

        {/* Load more button */}
        {hasMore && (
          <div className="flex justify-center mt-6">
            <Button
              onClick={handleLoadMore}
              disabled={loadingMore}
              variant="outline"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading...
                </>
              ) : (
                "Load More"
              )}
            </Button>
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

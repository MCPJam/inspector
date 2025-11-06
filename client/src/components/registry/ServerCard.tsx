import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink, Clock } from "lucide-react";
import type { RegistryServer } from "@/shared/types";

interface ServerCardProps {
  server: RegistryServer;
  onInstall: (server: RegistryServer, packageIdx?: number, remoteIdx?: number) => void;
  onViewDetails: (server: RegistryServer) => void;
}

export function ServerCard({ server, onInstall, onViewDetails }: ServerCardProps) {
  // Extract organization and project name from server.name
  const nameParts = server.name?.split("/") || ["", "Unknown"];
  const organization = nameParts[0] || "";
  const projectName = nameParts.slice(1).join("/") || server.name || "Unknown";

  // Determine badge info
  const isOfficial = server._meta?.official === true;
  const isRemote = server.remotes && server.remotes.length > 0;
  const hasPackages = server.packages && server.packages.length > 0;

  // Get download count from metadata if available
  const downloadCount = server._meta?.downloads || server._meta?.download_count;

  // Get metadata from the official registry provider
  const officialMeta = server._meta?.["io.modelcontextprotocol.registry/official"];
  const isLatest = officialMeta?.isLatest;
  const updatedAt = officialMeta?.updatedAt;
  const publishedAt = officialMeta?.publishedAt;

  // Format relative time
  const getRelativeTime = (dateString: string | undefined) => {
    if (!dateString) return null;
    const date = new Date(dateString);
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

    if (diffInDays === 0) return "today";
    if (diffInDays === 1) return "yesterday";
    if (diffInDays < 7) return `${diffInDays}d ago`;
    if (diffInDays < 30) return `${Math.floor(diffInDays / 7)}w ago`;
    if (diffInDays < 365) return `${Math.floor(diffInDays / 30)}mo ago`;
    return `${Math.floor(diffInDays / 365)}y ago`;
  };

  const relativeTime = getRelativeTime(updatedAt || publishedAt);

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-pointer group"
      onClick={() => onViewDetails(server)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {/* Organization/Icon placeholder */}
              <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-bold text-primary">
                  {organization.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <CardTitle className="text-base truncate">{projectName}</CardTitle>
                <p className="text-xs text-muted-foreground truncate">{organization}</p>
              </div>
            </div>
          </div>
        </div>
        <CardDescription className="line-clamp-2 text-xs mt-2">
          {server.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex flex-wrap gap-1.5">
            {isOfficial && (
              <Badge variant="secondary" className="text-xs">
                Official
              </Badge>
            )}
            {isLatest && (
              <Badge variant="default" className="text-xs bg-green-600 hover:bg-green-700">
                Latest
              </Badge>
            )}
            {isRemote && (
              <Badge variant="outline" className="text-xs">
                Remote
              </Badge>
            )}
            {hasPackages && server.packages![0] && (
              <Badge variant="outline" className="text-xs">
                {server.packages![0].registryType}
              </Badge>
            )}
          </div>
          {downloadCount && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Download className="h-3 w-3" />
              <span>{downloadCount.toLocaleString()}</span>
            </div>
          )}
        </div>
        {relativeTime && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-3">
            <Clock className="h-3 w-3" />
            <span>Updated {relativeTime}</span>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              onInstall(server);
            }}
          >
            Add to Inspector
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onViewDetails(server);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

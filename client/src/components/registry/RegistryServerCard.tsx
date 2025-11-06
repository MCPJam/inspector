import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, Clock } from "lucide-react";
import type { RegistryServer } from "@/shared/types";

interface RegistryServerCardProps {
  server: RegistryServer;
  onInstall: (
    server: RegistryServer,
    packageIdx?: number,
    remoteIdx?: number,
  ) => void;
  onViewDetails: (server: RegistryServer) => void;
}

export function RegistryServerCard({
  server,
  onInstall,
  onViewDetails,
}: RegistryServerCardProps) {
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
  const officialMeta =
    server._meta?.["io.modelcontextprotocol.registry/official"];
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
      className="border border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/50 hover:shadow-md hover:bg-card/70 transition-all duration-200 cursor-pointer group w-full min-h-[220px] flex flex-col"
      onClick={() => onViewDetails(server)}
    >
      <CardHeader className="pb-1">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="flex items-center gap-2 mb-1 min-w-0">
              {/* Organization/Icon placeholder */}
              <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-bold text-primary">
                  {organization.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0 overflow-hidden">
                <CardTitle className="text-base truncate">
                  {projectName}
                </CardTitle>
                <p className="text-xs text-muted-foreground truncate">
                  {organization}
                </p>
              </div>
              <Badge variant="outline" className="text-xs">
                {isRemote ? "Remote" : "Local"}
              </Badge>
            </div>
          </div>
        </div>
        <CardDescription className="line-clamp-2 text-xs mt-2">
          {server.description}
        </CardDescription>
        {relativeTime && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
            <Clock className="h-3 w-3" />
            <span>Updated {relativeTime}</span>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0 mt-auto">
        <div className="flex items-center justify-between mb-1">
          <div className="flex flex-wrap gap-1.5">
            {isOfficial && (
              <Badge variant="secondary" className="text-xs">
                Official
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

        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              onInstall(server);
            }}
          >
            Connect
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={(e) => {
              e.stopPropagation();
              onViewDetails(server);
            }}
          >
            View details
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink } from "lucide-react";
import type { RegistryServer } from "@/shared/types";

interface ServerCardProps {
  server: RegistryServer;
  onInstall: (server: RegistryServer) => void;
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

  return (
    <Card className="hover:shadow-md transition-shadow cursor-pointer group">
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
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-1.5">
            {isOfficial && (
              <Badge variant="secondary" className="text-xs">
                Official
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
        <div className="flex gap-2 mt-4">
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

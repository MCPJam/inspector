import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, Package, Globe, Terminal, Copy, Check, Code2, Github } from "lucide-react";
import type { RegistryServer } from "@/shared/types";
import { useState } from "react";

interface ServerDetailModalProps {
  server: RegistryServer | null;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (server: RegistryServer) => void;
}

export function ServerDetailModal({
  server,
  isOpen,
  onClose,
  onInstall,
}: ServerDetailModalProps) {
  const [copiedPackage, setCopiedPackage] = useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  if (!server) return null;

  const nameParts = server.name?.split("/") || ["", "Unknown"];
  const organization = nameParts[0] || "";
  const projectName = nameParts.slice(1).join("/") || server.name || "Unknown";

  const isOfficial = server._meta?.["io.modelcontextprotocol.registry/official"];
  const repositoryUrl = server._meta?.repository?.url;

  const handleCopyPackage = (packageId: string, command: string) => {
    navigator.clipboard.writeText(command);
    setCopiedPackage(packageId);
    setTimeout(() => setCopiedPackage(null), 2000);
  };

  const handleCopyJson = () => {
    const jsonString = JSON.stringify(server, null, 2);
    navigator.clipboard.writeText(jsonString);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh]">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-lg font-bold text-primary">
                    {organization.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <DialogTitle className="text-xl">{projectName}</DialogTitle>
                  <p className="text-sm text-muted-foreground">{organization}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {isOfficial && (
                  <Badge variant="secondary" className="text-xs">
                    Official
                  </Badge>
                )}
                {isOfficial?.isLatest && (
                  <Badge variant="default" className="text-xs bg-green-600 hover:bg-green-700">
                    Latest
                  </Badge>
                )}
                <Badge variant="outline" className="text-xs">
                  v{server.version}
                </Badge>
                {server.remotes && server.remotes.length > 0 && (
                  <Badge variant="outline" className="text-xs">
                    <Globe className="h-3 w-3 mr-1" />
                    Remote
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="space-y-6">
            {/* Description */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Description</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {server.description}
              </p>
            </div>

            <Separator />

            {/* Packages */}
            {server.packages && server.packages.length > 0 && (
              <>
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Package className="h-4 w-4" />
                    Packages
                  </h3>
                  <div className="space-y-3">
                    {server.packages.map((pkg, idx) => {
                      const installCommand =
                        pkg.registryType === "npm"
                          ? `npx -y ${pkg.identifier}`
                          : pkg.registryType === "pypi"
                            ? `pip install ${pkg.identifier}`
                            : pkg.identifier;

                      return (
                        <div
                          key={idx}
                          className="border border-border rounded-lg p-3 space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className="text-xs">
                                {pkg.registryType}
                              </Badge>
                              <code className="text-xs">{pkg.identifier}</code>
                            </div>
                            {pkg.version && (
                              <span className="text-xs text-muted-foreground">
                                v{pkg.version}
                              </span>
                            )}
                          </div>
                          {pkg.registryType === "npm" || pkg.registryType === "pypi" ? (
                            <div className="flex items-center gap-2">
                              <code className="flex-1 text-xs bg-muted px-3 py-2 rounded">
                                {installCommand}
                              </code>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleCopyPackage(pkg.identifier, installCommand)}
                              >
                                {copiedPackage === pkg.identifier ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <Separator />
              </>
            )}

            {/* Remotes */}
            {server.remotes && server.remotes.length > 0 && (
              <>
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    Remote Connections
                  </h3>
                  <div className="space-y-3">
                    {server.remotes.map((remote, idx) => (
                      <div
                        key={idx}
                        className="border border-border rounded-lg p-3 space-y-2"
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">
                            {remote.type}
                          </Badge>
                          {remote.url && (
                            <code className="text-xs text-muted-foreground">
                              {remote.url}
                            </code>
                          )}
                          {remote.command && (
                            <code className="text-xs text-muted-foreground">
                              {remote.command}
                            </code>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <Separator />
              </>
            )}

            {/* Repository Link */}
            {repositoryUrl && (
              <>
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Github className="h-4 w-4" />
                    Repository
                  </h3>
                  <a
                    href={repositoryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-accent transition-colors"
                  >
                    <span className="text-sm font-medium">{repositoryUrl}</span>
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
                <Separator />
              </>
            )}

            {/* Raw JSON Viewer */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Code2 className="h-4 w-4" />
                  Raw JSON
                </h3>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCopyJson}
                  >
                    {copiedJson ? (
                      <>
                        <Check className="h-3.5 w-3.5 mr-2" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5 mr-2" />
                        Copy
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowRawJson(!showRawJson)}
                  >
                    {showRawJson ? "Hide" : "View"}
                  </Button>
                </div>
              </div>
              {showRawJson && (
                <div className="relative">
                  <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto max-h-96">
                    <code>{JSON.stringify(server, null, 2)}</code>
                  </pre>
                </div>
              )}
            </div>

            {/* Metadata */}
            {isOfficial && (
              <div className="bg-muted/50 rounded-lg p-3">
                <div className="text-xs space-y-1">
                  {isOfficial.publishedAt && (
                    <p className="text-muted-foreground">
                      Published:{" "}
                      {new Date(isOfficial.publishedAt).toLocaleDateString()}
                    </p>
                  )}
                  {isOfficial.updatedAt && (
                    <p className="text-muted-foreground">
                      Updated:{" "}
                      {new Date(isOfficial.updatedAt).toLocaleDateString()}
                    </p>
                  )}
                  {isOfficial.isLatest && (
                    <p className="text-muted-foreground">
                      ✓ Latest version
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => onInstall(server)}>
            <Terminal className="h-4 w-4 mr-2" />
            Add to Inspector
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

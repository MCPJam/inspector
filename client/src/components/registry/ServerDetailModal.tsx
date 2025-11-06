import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, Package, Globe, Terminal, Copy, Check, Code2, Github, Home, Image, Hash, FolderTree, Shield } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
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
  const [showPublisherMeta, setShowPublisherMeta] = useState(false);

  if (!server) return null;

  const nameParts = server.name?.split("/") || ["", "Unknown"];
  const organization = nameParts[0] || "";
  const projectName = nameParts.slice(1).join("/") || server.name || "Unknown";

  const isOfficial = server._meta?.["io.modelcontextprotocol.registry/official"];
  const repository = server.repository;
  const repositoryUrl = repository?.url;
  const websiteUrl = server.websiteUrl;
  const title = server.title || projectName;
  const icons = server.icons || [];
  const schema = server.$schema;

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

  // No-op

  const renderJson = (data: any, maxHeightClass: string = "max-h-40") => (
    <div className={`rounded-sm bg-muted p-2 overflow-auto ${maxHeightClass}`}>
      <JsonView
        src={data}
        dark={true}
        theme="atom"
        enableClipboard={true}
        displaySize={false}
        collapsed={false}
        style={{
          fontSize: "11px",
          fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
          backgroundColor: "transparent",
          padding: "0",
          borderRadius: "0",
          border: "none",
        }}
      />
    </div>
  );

  const renderArgs = (label: string, args: any[]) => {
    if (!Array.isArray(args) || args.length === 0) return null;
    const allStrings = args.every((a) => typeof a === "string");
    return (
      <div>
        <span className="font-semibold">{label}:</span>
        {allStrings ? (
          <code className="ml-2">{(args as string[]).join(" ")}</code>
        ) : (
          <div className="mt-1">{renderJson(args)}</div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh]">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                {icons.length > 0 ? (
                  <div className="w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0 bg-background border">
                    <img
                      src={icons[0].src}
                      alt={`${title} icon`}
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        // Fallback to text avatar if image fails to load
                        const target = e.target as HTMLImageElement;
                        target.style.display = 'none';
                        if (target.parentElement) {
                          target.parentElement.innerHTML = `<span class="text-lg font-bold text-primary">${organization.charAt(0).toUpperCase()}</span>`;
                        }
                      }}
                    />
                  </div>
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-lg font-bold text-primary">
                      {organization.charAt(0).toUpperCase()}
                    </span>
                  </div>
                )}
                <div>
                  <DialogTitle className="text-xl">{title}</DialogTitle>
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
                {server.status && (
                  <Badge
                    variant="outline"
                    className={`text-xs ${
                      server.status.toLowerCase() === "active"
                        ? "bg-green-600/15 text-green-700 dark:text-green-400"
                        : server.status.toLowerCase() === "deprecated"
                          ? "bg-yellow-600/15 text-yellow-700 dark:text-yellow-400"
                          : server.status.toLowerCase() === "deleted"
                            ? "bg-red-600/15 text-red-700 dark:text-red-400"
                            : ""
                    }`}
                  >
                    {server.status}
                  </Badge>
                )}
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
              {/* Identifier */}
              <div className="mt-3 text-xs">
                <span className="font-semibold mr-2">Identifier:</span>
                <code className="bg-muted px-2 py-1 rounded">{server.name}</code>
              </div>
            </div>

            <Separator />

            {/* Icons */}
            {icons.length > 1 && (
              <>
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Image className="h-4 w-4" />
                    Icons
                  </h3>
                  <div className="flex flex-wrap gap-3">
                    {icons.map((icon, idx) => (
                      <div
                        key={idx}
                        className="border border-border rounded-lg p-2 space-y-2"
                      >
                        <div className="w-16 h-16 flex items-center justify-center bg-background">
                          <img
                            src={icon.src}
                            alt={`${title} icon ${idx + 1}`}
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                        <div className="text-xs text-muted-foreground space-y-1">
                          {icon.sizes && icon.sizes.length > 0 && (
                            <div>Sizes: {icon.sizes.join(", ")}</div>
                          )}
                          {icon.mimeType && <div>Type: {icon.mimeType}</div>}
                          {icon.theme && <div>Theme: {icon.theme}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <Separator />
              </>
            )}

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

                          {/* Additional package details */}
                          <div className="text-xs text-muted-foreground space-y-1 mt-2">
                            {pkg.registryBaseUrl && (
                              <div>Registry: {pkg.registryBaseUrl}</div>
                            )}
                            {pkg.runtimeHint && (
                              <div>Runtime: {pkg.runtimeHint}</div>
                            )}
                            {pkg.fileSha256 && (
                              <div className="flex items-center gap-2">
                                <Shield className="h-3 w-3" />
                                <span className="font-mono break-all">SHA256: {pkg.fileSha256}</span>
                              </div>
                            )}
                            {pkg.runtimeArguments && renderArgs("Runtime Args", pkg.runtimeArguments as any)}
                            {pkg.packageArguments && renderArgs("Package Args", pkg.packageArguments as any)}
                            {pkg.environmentVariables && pkg.environmentVariables.length > 0 && (
                              <div>
                                <span className="font-semibold">Environment Variables:</span>
                                <div className="ml-2 mt-1 space-y-1">
                                  {pkg.environmentVariables.map((env: any, envIdx: number) => {
                                    const hasSimpleShape = typeof env?.name === "string";
                                    return (
                                      <div key={envIdx}>
                                        {hasSimpleShape ? (
                                          <div className="flex items-center gap-2">
                                            <code className="font-mono">{env.name}</code>
                                            <span className="text-muted-foreground">
                                              {env.value ?? env.default ?? env.description ?? "(required)"}
                                            </span>
                                          </div>
                                        ) : (
                                          renderJson(env)
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {pkg.transport && (
                              <div>
                                <span className="font-semibold">Transport:</span>
                                <div className="mt-1 ml-0">{renderJson(pkg.transport)}</div>
                              </div>
                            )}
                          </div>
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
                            <code className="text-xs text-muted-foreground break-all">
                              {remote.url}
                            </code>
                          )}
                          {remote.command && (
                            <code className="text-xs text-muted-foreground">
                              {remote.command}
                            </code>
                          )}
                        </div>
                      {/* Remote args */}
                      {remote.args && remote.args.length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          <span className="font-semibold">Args:</span>
                          <code className="ml-2">{remote.args.join(" ")}</code>
                        </div>
                      )}
                      {/* Remote env */}
                      {remote.env && Object.keys(remote.env).length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          <span className="font-semibold">Env:</span>
                          <div className="ml-2 mt-1 space-y-1 font-mono">
                            {Object.entries(remote.env).map(([k, v]) => (
                              <div key={k} className="break-all">
                                {k}: {String(v)}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                        {/* Remote headers */}
                        {remote.headers && remote.headers.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            <span className="font-semibold">Headers:</span>
                            <div className="ml-2 mt-1 space-y-1 font-mono">
                            {remote.headers.map((header: any, headerIdx: number) => {
                              if (typeof header?.name === "string") {
                                return (
                                  <div key={headerIdx}>
                                    {header.name}: {header.value}
                                  </div>
                                );
                              }
                              return <div key={headerIdx}>{renderJson(header)}</div>;
                            })}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <Separator />
              </>
            )}

            {/* Website URL */}
            {websiteUrl && (
              <>
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Home className="h-4 w-4" />
                    Website
                  </h3>
                  <a
                    href={websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-accent transition-colors"
                  >
                    <span className="text-sm font-medium">{websiteUrl}</span>
                    <ExternalLink className="h-4 w-4" />
                  </a>
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
                  <div className="space-y-2">
                    <a
                      href={repositoryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-accent transition-colors"
                    >
                      <span className="text-sm font-medium">{repositoryUrl}</span>
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    {repository && (
                      <div className="text-xs text-muted-foreground space-y-1 ml-4">
                        {repository.id && (
                          <div className="flex items-center gap-2">
                            <Hash className="h-3 w-3" />
                            <span>ID: {repository.id}</span>
                          </div>
                        )}
                        {repository.source && (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs">
                              {repository.source}
                            </Badge>
                          </div>
                        )}
                        {repository.subfolder && (
                          <div className="flex items-center gap-2">
                            <FolderTree className="h-3 w-3" />
                            <span>Subfolder: {repository.subfolder}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
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
              {showRawJson && <div className="relative">{renderJson(server, "max-h-96")}</div>}
            </div>

            {/* Metadata */}
            {(isOfficial || schema) && (
              <div className="bg-muted/50 rounded-lg p-3">
                <div className="text-xs space-y-1">
                  {isOfficial?.publishedAt && (
                    <p className="text-muted-foreground">
                      Published:{" "}
                      {new Date(isOfficial.publishedAt).toLocaleDateString()}
                    </p>
                  )}
                  {isOfficial?.updatedAt && (
                    <p className="text-muted-foreground">
                      Updated:{" "}
                      {new Date(isOfficial.updatedAt).toLocaleDateString()}
                    </p>
                  )}
                  {isOfficial?.isLatest && (
                    <p className="text-muted-foreground">
                      ✓ Latest version
                    </p>
                  )}
                  {schema && (
                    <p className="text-muted-foreground break-all">
                      Schema: <code className="text-xs">{schema}</code>
                    </p>
                  )}
                  {server._meta?.["io.modelcontextprotocol.registry/publisher-provided"] && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">Publisher-provided Metadata</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setShowPublisherMeta((v) => !v)}
                        >
                          {showPublisherMeta ? "Hide" : "View"}
                        </Button>
                      </div>
                      {showPublisherMeta && (
                        <div className="mt-2">
                          {renderJson(
                            server._meta?.[
                              "io.modelcontextprotocol.registry/publisher-provided"
                            ],
                            "max-h-60"
                          )}
                        </div>
                      )}
                    </div>
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

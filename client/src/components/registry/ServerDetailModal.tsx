import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ExternalLink,
  Globe,
  Terminal,
  Copy,
  Check,
  Github,
  Home,
  Loader2,
} from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import type { RegistryServer } from "@/shared/types";
import { useState, useEffect } from "react";
import { listServerVersions, getServerVersion } from "@/lib/apis/registry-api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface RegistryServerDetailModalProps {
  server: RegistryServer | null;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (
    server: RegistryServer,
    packageIdx?: number,
    remoteIdx?: number,
  ) => void;
}

export function RegistryServerDetailModal({
  server: initialServer,
  isOpen,
  onClose,
  onInstall,
}: RegistryServerDetailModalProps) {
  const [copiedPackage, setCopiedPackage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("details");
  const [copiedJson, setCopiedJson] = useState(false);
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [currentServer, setCurrentServer] = useState<RegistryServer | null>(
    initialServer,
  );
  const [loadingVersion, setLoadingVersion] = useState(false);

  // Fetch available versions when modal opens or server changes
  useEffect(() => {
    if (isOpen && initialServer?.name) {
      setCurrentServer(initialServer);
      setSelectedVersion(initialServer.version);

      // Fetch all available versions
      listServerVersions(initialServer.name)
        .then((response) => {
          // Handle both formats: {versions: string[]} or {servers: [{server: {version: string}}]}
          if (response.versions && Array.isArray(response.versions)) {
            setAvailableVersions(response.versions);
          } else if (
            (response as any).servers &&
            Array.isArray((response as any).servers)
          ) {
            // Extract versions from servers array
            const versions = (response as any).servers
              .map((s: any) => s.server?.version)
              .filter(Boolean);
            setAvailableVersions(versions);
          } else {
            setAvailableVersions([initialServer.version]);
          }
        })
        .catch((error) => {
          console.error("Failed to fetch versions:", error);
          setAvailableVersions([initialServer.version]);
        });
    }
  }, [isOpen, initialServer]);

  // Handle version change
  const handleVersionChange = async (version: string) => {
    if (!initialServer?.name || version === selectedVersion) return;

    setLoadingVersion(true);
    setSelectedVersion(version);

    try {
      const response = await getServerVersion(initialServer.name, version);

      // The API returns {server: {...}, _meta: {...}} format
      const versionServer = (response as any).server || response;
      const versionMeta = (response as any)._meta || {};

      // Update current server with the new version data
      setCurrentServer({
        ...versionServer,
        _meta: {
          ...versionServer._meta,
          ...versionMeta,
        },
      });
    } catch (error) {
      console.error("Failed to fetch version details:", error);
      // Revert to previous version on error
      setSelectedVersion(currentServer?.version || initialServer.version);
    } finally {
      setLoadingVersion(false);
    }
  };

  if (!currentServer) return null;

  const server = currentServer;

  const nameParts = server.name?.split("/") || ["", "Unknown"];
  const organization = nameParts[0] || "";
  const projectName = nameParts.slice(1).join("/") || server.name || "Unknown";

  const isOfficial =
    server._meta?.["io.modelcontextprotocol.registry/official"];
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
    <div
      className={`rounded-md border border-border bg-background/60 p-2 overflow-auto ${maxHeightClass}`}
    >
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
          minHeight: "0",
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
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col min-h-0"
        >
          <DialogHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-3">
                  {icons.length > 0 ? (
                    <div className="w-12 h-12 rounded overflow-hidden flex items-center justify-center flex-shrink-0 bg-muted">
                      <img
                        src={icons[0].src}
                        alt={`${title} icon`}
                        className="w-full h-full object-contain"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          target.style.display = "none";
                          if (target.parentElement) {
                            target.parentElement.innerHTML = `<span class="text-xl font-semibold">${organization.charAt(0).toUpperCase()}</span>`;
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <div className="w-12 h-12 rounded bg-muted flex items-center justify-center flex-shrink-0">
                      <span className="text-xl font-semibold">
                        {organization.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div>
                    <DialogTitle className="text-xl font-semibold">
                      {title}
                    </DialogTitle>
                    <p className="text-sm text-muted-foreground">
                      {organization}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <div className="flex flex-wrap gap-2 items-center">
                    {availableVersions.length > 1 ? (
                      <Select
                        value={selectedVersion}
                        onValueChange={handleVersionChange}
                        disabled={loadingVersion}
                      >
                        <SelectTrigger className="w-[120px] h-7 text-xs">
                          <SelectValue>
                            {loadingVersion ? (
                              <span className="flex items-center gap-1">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading...
                              </span>
                            ) : (
                              `v${selectedVersion}`
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {availableVersions.map((version) => (
                            <SelectItem
                              key={version}
                              value={version}
                              className="text-xs"
                            >
                              v{version}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span>v{server.version}</span>
                    )}
                    {server.status && <span>• {server.status}</span>}
                    {server.remotes && server.remotes.length > 0 && (
                      <span>• Remote</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <TabsList>
                      <TabsTrigger value="details">Details</TabsTrigger>
                      <TabsTrigger value="raw">Raw JSON</TabsTrigger>
                    </TabsList>
                    {activeTab === "raw" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleCopyJson}
                      >
                        {copiedJson ? (
                          <>
                            <Check className="h-3.5 w-3.5 mr-2" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5 mr-2" /> Copy
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </DialogHeader>

          <TabsContent
            value="details"
            className="flex-1 overflow-auto mt-4 data-[state=active]:flex data-[state=active]:flex-col"
          >
            <div className="space-y-6 pb-4">
              {/* Description */}
              <div>
                <p className="text-sm leading-relaxed">{server.description}</p>
              </div>

              <Separator className="my-6" />

              {/* Packages */}
              {server.packages && server.packages.length > 0 && (
                <>
                  <div>
                    <h3 className="text-sm font-medium mb-4">Packages</h3>
                    <div className="space-y-4">
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
                            className="border rounded p-4 space-y-3"
                          >
                            <div className="flex items-center justify-between">
                              <code className="text-xs font-mono">
                                {pkg.identifier}
                              </code>
                              <span className="text-xs text-muted-foreground">
                                {pkg.registryType}{" "}
                                {pkg.version && `• v${pkg.version}`}
                              </span>
                            </div>

                            {pkg.registryType === "npm" ||
                            pkg.registryType === "pypi" ? (
                              <div className="flex items-center gap-2">
                                <code className="flex-1 text-xs bg-muted px-3 py-2 rounded font-mono">
                                  {installCommand}
                                </code>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    handleCopyPackage(
                                      pkg.identifier,
                                      installCommand,
                                    )
                                  }
                                >
                                  {copiedPackage === pkg.identifier ? (
                                    <Check className="h-4 w-4" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            ) : null}

                            {/* Additional package details */}
                            {(pkg.runtimeHint ||
                              pkg.environmentVariables?.length ||
                              pkg.transport) && (
                              <div className="text-xs text-muted-foreground space-y-2 pt-2 border-t">
                                {pkg.runtimeHint && (
                                  <div>Runtime: {pkg.runtimeHint}</div>
                                )}
                                {pkg.environmentVariables &&
                                  pkg.environmentVariables.length > 0 && (
                                    <div>
                                      <div className="font-medium mb-1">
                                        Environment Variables:
                                      </div>
                                      <div className="ml-2 space-y-1">
                                        {pkg.environmentVariables.map(
                                          (env: any, envIdx: number) => {
                                            const hasSimpleShape =
                                              typeof env?.name === "string";
                                            return (
                                              <div key={envIdx}>
                                                {hasSimpleShape ? (
                                                  <div className="font-mono">
                                                    {env.name}
                                                    {env.isRequired && (
                                                      <span className="text-red-500 ml-1">
                                                        *
                                                      </span>
                                                    )}
                                                  </div>
                                                ) : (
                                                  renderJson(env)
                                                )}
                                              </div>
                                            );
                                          },
                                        )}
                                      </div>
                                    </div>
                                  )}
                                {pkg.transport && (
                                  <div>
                                    <div className="font-medium mb-1">
                                      Transport:
                                    </div>
                                    {typeof pkg.transport === "object" &&
                                    pkg.transport !== null &&
                                    Object.keys(pkg.transport).every((k) =>
                                      ["type", "url"].includes(k),
                                    ) ? (
                                      <code className="font-mono">
                                        {`{ type: "${(pkg.transport as any).type}"${(pkg.transport as any).url ? `, url: "${(pkg.transport as any).url}"` : ""} }`}
                                      </code>
                                    ) : (
                                      <div className="mt-1">
                                        {renderJson(
                                          pkg.transport,
                                          "max-h-[120px]",
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Connect button for this package (skip mcpb for desktop) */}
                            {pkg.registryType !== "mcpb" && (
                              <Button
                                size="sm"
                                className="w-full"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onInstall(server, idx, undefined);
                                }}
                              >
                                <Terminal className="h-4 w-4 mr-2" />
                                Connect
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <Separator className="my-6" />
                </>
              )}

              {/* Remotes */}
              {server.remotes && server.remotes.length > 0 && (
                <>
                  <div>
                    <h3 className="text-sm font-medium mb-4">
                      Remote Connections
                    </h3>
                    <div className="space-y-4">
                      {server.remotes.map((remote, idx) => (
                        <div key={idx} className="border rounded p-4 space-y-3">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-muted-foreground">
                              {remote.type}
                            </span>
                            {remote.url && (
                              <code className="font-mono text-muted-foreground break-all">
                                {remote.url}
                              </code>
                            )}
                            {remote.command && (
                              <code className="font-mono text-muted-foreground">
                                {remote.command}
                              </code>
                            )}
                          </div>

                          {/* Remote details */}
                          {(remote.args?.length ||
                            remote.env ||
                            remote.headers?.length) && (
                            <div className="text-xs text-muted-foreground space-y-2 pt-2 border-t">
                              {remote.args && remote.args.length > 0 && (
                                <div>
                                  <div className="font-medium mb-1">Args:</div>
                                  <code className="font-mono">
                                    {remote.args.join(" ")}
                                  </code>
                                </div>
                              )}
                              {remote.env &&
                                Object.keys(remote.env).length > 0 && (
                                  <div>
                                    <div className="font-medium mb-1">
                                      Environment:
                                    </div>
                                    <div className="ml-2 space-y-1 font-mono">
                                      {Object.entries(remote.env).map(
                                        ([k, v]) => (
                                          <div key={k} className="break-all">
                                            {k}: {String(v)}
                                          </div>
                                        ),
                                      )}
                                    </div>
                                  </div>
                                )}
                              {remote.headers && remote.headers.length > 0 && (
                                <div>
                                  <div className="font-medium mb-1">
                                    Headers:
                                  </div>
                                  <div className="ml-2 space-y-1 font-mono">
                                    {remote.headers.map(
                                      (header: any, headerIdx: number) => {
                                        if (typeof header?.name === "string") {
                                          return (
                                            <div key={headerIdx}>
                                              {header.name}
                                              {header.isRequired && (
                                                <span className="text-red-500 ml-1">
                                                  *
                                                </span>
                                              )}
                                            </div>
                                          );
                                        }
                                        return (
                                          <div key={headerIdx}>
                                            {renderJson(header)}
                                          </div>
                                        );
                                      },
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Connect button for this remote */}
                          <Button
                            size="sm"
                            className="w-full"
                            onClick={(e) => {
                              e.stopPropagation();
                              onInstall(server, undefined, idx);
                            }}
                          >
                            <Terminal className="h-4 w-4 mr-2" />
                            Connect
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <Separator className="my-6" />
                </>
              )}

              {/* Links */}
              {(websiteUrl || repositoryUrl) && (
                <>
                  <div className="space-y-2">
                    {websiteUrl && (
                      <a
                        href={websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm hover:underline"
                      >
                        <Home className="h-4 w-4" />
                        <span>Website</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {repositoryUrl && (
                      <a
                        href={repositoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm hover:underline"
                      >
                        <Github className="h-4 w-4" />
                        <span>Repository</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <Separator className="my-6" />
                </>
              )}

              {/* Raw JSON moved to tabs */}

              {/* Metadata */}
              {(isOfficial?.publishedAt || isOfficial?.updatedAt || schema) && (
                <div className="text-xs text-muted-foreground space-y-1">
                  {isOfficial?.publishedAt && (
                    <div>
                      Published:{" "}
                      {new Date(isOfficial.publishedAt).toLocaleDateString()}
                    </div>
                  )}
                  {isOfficial?.updatedAt && (
                    <div>
                      Updated:{" "}
                      {new Date(isOfficial.updatedAt).toLocaleDateString()}
                    </div>
                  )}
                  {schema && (
                    <div className="break-all">
                      Schema: <code className="font-mono">{schema}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="raw" className="flex-1 overflow-auto mt-4">
            <div className="pb-4">{renderJson(server, "max-h-full")}</div>
          </TabsContent>
        </Tabs>

        {/* Footer Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t mt-4 flex-shrink-0">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => onInstall(server)}>Connect</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useOrgModelConfig,
  type OrgModelProvider,
} from "@/hooks/use-org-model-config";

// ---------------------------------------------------------------------------
// Provider catalog -- defines known providers and their configuration fields
// ---------------------------------------------------------------------------

type ProviderKind =
  | "api-key-only"
  | "azure"
  | "ollama"
  | "openrouter"
  | "custom";

interface ProviderCatalogEntry {
  key: string;
  name: string;
  kind: ProviderKind;
  logo?: string;
}

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { key: "openai", name: "OpenAI", kind: "api-key-only", logo: "/openai_logo.svg" },
  { key: "anthropic", name: "Anthropic", kind: "api-key-only", logo: "/anthropic_logo.svg" },
  { key: "google", name: "Google", kind: "api-key-only", logo: "/google_logo.svg" },
  { key: "deepseek", name: "DeepSeek", kind: "api-key-only", logo: "/deepseek_logo.svg" },
  { key: "mistral", name: "Mistral", kind: "api-key-only", logo: "/mistral_logo.svg" },
  { key: "xai", name: "xAI", kind: "api-key-only", logo: "/xai_logo.svg" },
  { key: "azure", name: "Azure OpenAI", kind: "azure", logo: "/azure_logo.png" },
  { key: "ollama", name: "Ollama", kind: "ollama", logo: "/ollama_logo.svg" },
  { key: "openrouter", name: "OpenRouter", kind: "openrouter", logo: "/openrouter_logo.png" },
];

function findCatalogEntry(key: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.key === key);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface OrganizationModelsSectionProps {
  organizationId: string;
  isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OrganizationModelsSection({
  organizationId,
  isAdmin,
}: OrganizationModelsSectionProps) {
  const { providers, isLoading, upsertProvider, deleteProvider, isSaving } =
    useOrgModelConfig(organizationId);

  // Dialog state
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [configTarget, setConfigTarget] = useState<{
    providerKey: string;
    kind: ProviderKind;
    name: string;
    existing?: OrgModelProvider;
  } | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    providerKey: string;
    name: string;
  } | null>(null);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [editingCustom, setEditingCustom] = useState<OrgModelProvider | null>(
    null,
  );

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const openConfigDialog = (
    entry: ProviderCatalogEntry,
    existing?: OrgModelProvider,
  ) => {
    setConfigTarget({
      providerKey: entry.key,
      kind: entry.kind,
      name: entry.name,
      existing,
    });
    setConfigDialogOpen(true);
  };

  const openDeleteConfirm = (providerKey: string, name: string) => {
    setDeleteTarget({ providerKey, name });
    setDeleteConfirmOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteProvider(deleteTarget.providerKey);
      toast.success(`${deleteTarget.name} removed`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove provider",
      );
    } finally {
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    }
  };

  const openAddCustom = () => {
    setEditingCustom(null);
    setCustomDialogOpen(true);
  };

  const openEditCustom = (provider: OrgModelProvider) => {
    setEditingCustom(provider);
    setCustomDialogOpen(true);
  };

  // -----------------------------------------------------------------------
  // Derived data
  // -----------------------------------------------------------------------

  // Merge catalog with actual server data so we always show all known
  // providers and any extra custom providers returned from the server.
  const providerMap = new Map<string, OrgModelProvider>();
  providers?.forEach((p) => providerMap.set(p.providerKey, p));

  const knownProviderKeys = new Set(PROVIDER_CATALOG.map((c) => c.key));
  const customProviders =
    providers?.filter((p) => !knownProviderKeys.has(p.providerKey)) ?? [];

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <>
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xl">
            <Settings2 className="size-4 text-muted-foreground" />
            Model Providers
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "Configure AI model providers for your organization. API keys are stored securely and shared with all members."
              : "View which AI model providers are configured for your organization."}
          </p>
        </CardHeader>

        <CardContent className="space-y-1 pt-0">
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading providers...
            </div>
          ) : (
            <>
              {PROVIDER_CATALOG.map((entry) => {
                const provider = providerMap.get(entry.key);
                const configured = !!provider?.hasSecret || !!provider?.baseUrl;
                return (
                  <ProviderRow
                    key={entry.key}
                    name={entry.name}
                    logo={entry.logo}
                    configured={configured}
                    isAdmin={isAdmin}
                    onConfigure={() => openConfigDialog(entry, provider)}
                    onRemove={() => openDeleteConfirm(entry.key, entry.name)}
                  />
                );
              })}

              {customProviders.map((cp) => (
                <ProviderRow
                  key={cp.providerKey}
                  name={cp.displayName || cp.providerKey}
                  configured={!!cp.hasSecret || !!cp.baseUrl}
                  isAdmin={isAdmin}
                  isCustom
                  onConfigure={() => openEditCustom(cp)}
                  onRemove={() =>
                    openDeleteConfirm(
                      cp.providerKey,
                      cp.displayName || cp.providerKey,
                    )
                  }
                />
              ))}

              {isAdmin ? (
                <div className="pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openAddCustom}
                  >
                    <Plus className="mr-2 size-4" />
                    Add Custom Provider
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* Config dialog for known providers */}
      {configTarget ? (
        <KnownProviderConfigDialog
          open={configDialogOpen}
          onOpenChange={setConfigDialogOpen}
          providerKey={configTarget.providerKey}
          kind={configTarget.kind}
          name={configTarget.name}
          existing={configTarget.existing}
          isSaving={isSaving}
          onSave={async (args) => {
            try {
              await upsertProvider(args);
              toast.success(`${configTarget.name} configured`);
              setConfigDialogOpen(false);
              setConfigTarget(null);
            } catch (err) {
              toast.error(
                err instanceof Error
                  ? err.message
                  : "Failed to save provider",
              );
            }
          }}
          onCancel={() => {
            setConfigDialogOpen(false);
            setConfigTarget(null);
          }}
        />
      ) : null}

      {/* Custom provider dialog */}
      <OrgCustomProviderDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        editProvider={editingCustom}
        isSaving={isSaving}
        onSave={async (args) => {
          try {
            await upsertProvider(args);
            toast.success(
              editingCustom
                ? "Custom provider updated"
                : "Custom provider added",
            );
            setCustomDialogOpen(false);
            setEditingCustom(null);
          } catch (err) {
            toast.error(
              err instanceof Error
                ? err.message
                : "Failed to save custom provider",
            );
          }
        }}
        onCancel={() => {
          setCustomDialogOpen(false);
          setEditingCustom(null);
        }}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            setDeleteConfirmOpen(false);
            setDeleteTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the provider configuration including any stored
              API keys. Organization members will no longer be able to use
              models from this provider.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              disabled={isSaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// ProviderRow
// ---------------------------------------------------------------------------

function ProviderRow({
  name,
  logo,
  configured,
  isAdmin,
  isCustom,
  onConfigure,
  onRemove,
}: {
  name: string;
  logo?: string;
  configured: boolean;
  isAdmin: boolean;
  isCustom?: boolean;
  onConfigure: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2.5">
      <div className="flex items-center gap-3">
        {logo ? (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card p-1">
            <img
              src={logo}
              alt={name}
              className="h-full w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-xs font-semibold text-muted-foreground">
            {name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {isCustom ? (
            <Badge variant="outline" className="text-[10px]">
              Custom
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {configured ? (
          <Badge
            variant="secondary"
            className="gap-1 text-xs text-emerald-600 dark:text-emerald-400"
          >
            <CheckCircle2 className="size-3" />
            Configured
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
            <Circle className="size-3" />
            Not configured
          </Badge>
        )}

        {isAdmin ? (
          <>
            <Button variant="ghost" size="sm" onClick={onConfigure}>
              {configured ? (
                <Pencil className="size-3.5" />
              ) : (
                <>
                  <Settings2 className="mr-1.5 size-3.5" />
                  Configure
                </>
              )}
            </Button>
            {configured ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRemove}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KnownProviderConfigDialog
// ---------------------------------------------------------------------------

function KnownProviderConfigDialog({
  open,
  onOpenChange,
  providerKey,
  kind,
  name,
  existing,
  isSaving,
  onSave,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerKey: string;
  kind: ProviderKind;
  name: string;
  existing?: OrgModelProvider;
  isSaving: boolean;
  onSave: (args: {
    providerKey: string;
    secret?: string;
    baseUrl?: string;
    selectedModels?: string[];
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [selectedModels, setSelectedModels] = useState("");

  // Reset fields when dialog opens
  useEffect(() => {
    if (open) {
      setSecret("");
      setBaseUrl(existing?.baseUrl ?? "");
      setSelectedModels(existing?.selectedModels?.join(", ") ?? "");
    }
  }, [open, existing]);

  const catalogEntry = findCatalogEntry(providerKey);
  const logo = catalogEntry?.logo;

  const handleSave = () => {
    const args: Parameters<typeof onSave>[0] = { providerKey };
    if (secret.trim()) args.secret = secret.trim();
    if (baseUrl.trim()) args.baseUrl = baseUrl.trim();
    if (kind === "openrouter" && selectedModels.trim()) {
      args.selectedModels = selectedModels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    void onSave(args);
  };

  const canSave = (() => {
    switch (kind) {
      case "api-key-only":
        return !!secret.trim() || existing?.hasSecret;
      case "azure":
        return !!baseUrl.trim();
      case "ollama":
        return !!baseUrl.trim();
      case "openrouter":
        return (!!secret.trim() || existing?.hasSecret) && !!selectedModels.trim();
      default:
        return false;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            {logo ? (
              <div className="w-12 h-12 rounded-lg bg-card p-2 border">
                <img
                  src={logo}
                  alt={name}
                  className="w-full h-full object-contain"
                />
              </div>
            ) : null}
            <div>
              <DialogTitle className="text-left">Configure {name}</DialogTitle>
              <DialogDescription className="text-left">
                {existing?.hasSecret
                  ? "Update the configuration. Leave API key blank to keep the existing key."
                  : `Set up ${name} for your organization.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* API key field -- all except ollama */}
          {kind !== "ollama" ? (
            <div>
              <label htmlFor="org-provider-secret" className="text-sm font-medium">
                API Key
                {existing?.hasSecret ? (
                  <span className="text-muted-foreground font-normal ml-1">
                    (leave blank to keep current)
                  </span>
                ) : null}
              </label>
              <Input
                id="org-provider-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={existing?.hasSecret ? "********" : "sk-..."}
                className="mt-1"
              />
            </div>
          ) : null}

          {/* Base URL field -- azure, ollama */}
          {(kind === "azure" || kind === "ollama") ? (
            <div>
              <label htmlFor="org-provider-url" className="text-sm font-medium">
                Base URL
              </label>
              <Input
                id="org-provider-url"
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  kind === "azure"
                    ? "https://RESOURCE_NAME.openai.azure.com/openai"
                    : "http://127.0.0.1:11434/api"
                }
                className="mt-1"
              />
            </div>
          ) : null}

          {/* Selected models -- openrouter */}
          {kind === "openrouter" ? (
            <div>
              <label
                htmlFor="org-provider-models"
                className="text-sm font-medium"
              >
                Selected Models{" "}
                <span className="text-muted-foreground font-normal">
                  (comma-separated model IDs)
                </span>
              </label>
              <Input
                id="org-provider-models"
                type="text"
                value={selectedModels}
                onChange={(e) => setSelectedModels(e.target.value)}
                placeholder="openai/gpt-4o, anthropic/claude-3.5-sonnet"
                className="mt-1"
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// OrgCustomProviderDialog
// ---------------------------------------------------------------------------

function OrgCustomProviderDialog({
  open,
  onOpenChange,
  editProvider,
  isSaving,
  onSave,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editProvider: OrgModelProvider | null;
  isSaving: boolean;
  onSave: (args: {
    providerKey: string;
    secret?: string;
    baseUrl?: string;
    protocol?: string;
    modelIds?: string[];
    displayName?: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [protocol, setProtocol] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (editProvider) {
        setDisplayName(editProvider.displayName || editProvider.providerKey);
        setProtocol(editProvider.protocol || "openai-compatible");
        setBaseUrl(editProvider.baseUrl || "");
        setSecret("");
        setModelIds(editProvider.modelIds?.join(", ") ?? "");
      } else {
        setDisplayName("");
        setProtocol("openai-compatible");
        setBaseUrl("");
        setSecret("");
        setModelIds("");
      }
      setValidationError(null);
    }
  }, [open, editProvider]);

  const handleSave = () => {
    setValidationError(null);

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setValidationError("Provider name is required");
      return;
    }
    if (trimmedName.includes("/") || trimmedName.includes(":")) {
      setValidationError("Provider name cannot contain '/' or ':'");
      return;
    }

    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      setValidationError("Base URL is required");
      return;
    }

    const parsedModelIds = modelIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (parsedModelIds.length === 0) {
      setValidationError("At least one model name is required");
      return;
    }

    // Use lowercase name as providerKey for new providers, keep existing key for edits
    const providerKey = editProvider
      ? editProvider.providerKey
      : `custom-${trimmedName.toLowerCase().replace(/\s+/g, "-")}`;

    const args: Parameters<typeof onSave>[0] = {
      providerKey,
      displayName: trimmedName,
      protocol,
      baseUrl: trimmedBaseUrl,
      modelIds: parsedModelIds,
    };
    if (secret.trim()) args.secret = secret.trim();

    void onSave(args);
  };

  const isValid =
    displayName.trim() &&
    !displayName.includes("/") &&
    !displayName.includes(":") &&
    baseUrl.trim() &&
    modelIds.split(",").some((id) => id.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-left">
            {editProvider ? "Edit Custom Provider" : "Add Custom Provider"}
          </DialogTitle>
          <DialogDescription className="text-left">
            Connect to any OpenAI-compatible or Anthropic-compatible API
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="org-cp-name" className="text-sm font-medium">
              Provider Name
            </label>
            <Input
              id="org-cp-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. groq, together, vllm"
              className="mt-1"
              disabled={!!editProvider}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used to identify this provider. No slashes or colons.
            </p>
          </div>

          <div>
            <label htmlFor="org-cp-protocol" className="text-sm font-medium">
              Protocol
            </label>
            <Select value={protocol} onValueChange={setProtocol}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-compatible">
                  OpenAI Compatible
                </SelectItem>
                <SelectItem value="anthropic-compatible">
                  Anthropic Compatible
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label htmlFor="org-cp-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="org-cp-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.groq.com/openai/v1"
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="org-cp-secret" className="text-sm font-medium">
              API Key{" "}
              <span className="text-muted-foreground font-normal">
                (optional{editProvider?.hasSecret ? ", leave blank to keep current" : ""})
              </span>
            </label>
            <Input
              id="org-cp-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={editProvider?.hasSecret ? "********" : "sk-..."}
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="org-cp-models" className="text-sm font-medium">
              Model Names{" "}
              <span className="text-muted-foreground font-normal">
                (comma-separated)
              </span>
            </label>
            <Input
              id="org-cp-models"
              type="text"
              value={modelIds}
              onChange={(e) => setModelIds(e.target.value)}
              placeholder="llama-3.3-70b-versatile, mixtral-8x7b"
              className="mt-1"
            />
          </div>

          {validationError ? (
            <p className="text-sm text-destructive">{validationError}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isValid || isSaving}>
            {isSaving
              ? "Saving..."
              : editProvider
                ? "Save Changes"
                : "Add Provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

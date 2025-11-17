import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  getDefaultRegistrationStrategy,
  getSupportedRegistrationStrategies,
} from "@/lib/oauth/state-machines/factory";
import type { OAuthProtocolVersion } from "@/lib/oauth/state-machines/types";
import type {
  OAuthRegistrationStrategy,
  OAuthTestProfile,
} from "@/lib/oauth/profile";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { deriveOAuthProfileFromServer } from "./utils";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface OAuthProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server?: ServerWithName;
  existingServerNames: string[];
  onSave: (payload: {
    formData: ServerFormData;
    profile: OAuthTestProfile;
  }) => void;
}

interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

const createHeaderRow = (initial?: Partial<HeaderRow>): HeaderRow => {
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;

  return {
    id: randomId,
    key: initial?.key ?? "",
    value: initial?.value ?? "",
  };
};

const describeRegistrationStrategy = (strategy: string): string => {
  if (strategy === "cimd") return "CIMD (URL-based)";
  if (strategy === "dcr") return "Dynamic (DCR)";
  return "Pre-registered";
};

const getHostFromUrl = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

export function OAuthProfileModal({
  open,
  onOpenChange,
  server,
  existingServerNames,
  onSave,
}: OAuthProfileModalProps) {
  const derivedProfile = useMemo(
    () => deriveOAuthProfileFromServer(server),
    [server],
  );
  const [serverName, setServerName] = useState("");
  const [draft, setDraft] = useState(derivedProfile);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() =>
    derivedProfile.customHeaders.length
      ? derivedProfile.customHeaders.map((header) => createHeaderRow(header))
      : [createHeaderRow()],
  );
  const [error, setError] = useState<string | null>(null);
  const supportedStrategies = useMemo(
    () => getSupportedRegistrationStrategies(draft.protocolVersion),
    [draft.protocolVersion],
  );

  const generateDefaultName = useCallback(() => {
    const baseName = server?.name
      ? `${server.name}-debug`
      : derivedProfile.serverUrl
        ? getHostFromUrl(derivedProfile.serverUrl)
        : "oauth-flow-target";
    let candidate = baseName || "oauth-flow-target";
    let counter = 1;
    while (existingServerNames.includes(candidate)) {
      candidate = `${baseName || "oauth-flow-target"}-${counter++}`;
    }
    return candidate;
  }, [server?.name, derivedProfile.serverUrl, existingServerNames]);

  useEffect(() => {
    if (open) {
      setServerName(generateDefaultName());
      setDraft(derivedProfile);
      setHeaderRows(
        derivedProfile.customHeaders.length
          ? derivedProfile.customHeaders.map((header) =>
              createHeaderRow(header),
            )
          : [createHeaderRow()],
      );
      setError(null);
    }
  }, [open, derivedProfile, generateDefaultName]);

  const normalizedHeaders = useMemo(
    () =>
      headerRows
        .map((row) => ({
          key: row.key.trim(),
          value: row.value.trim(),
        }))
        .filter((row) => row.key.length > 0),
    [headerRows],
  );

  const getValidatedProfileValues = () => {
    const trimmedUrl = draft.serverUrl.trim();

    if (!trimmedUrl) {
      setError("Server URL is required");
      return null;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch (err) {
      console.error("Invalid OAuth target URL", err);
      setError("Enter a valid MCP base URL (e.g., https://example.com)");
      return null;
    }

    const trimmedClientId = draft.clientId.trim();
    const trimmedClientSecret = draft.clientSecret.trim();
    setError(null);

    return {
      trimmedUrl,
      trimmedClientId,
      trimmedClientSecret,
      parsedUrl,
    };
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validated = getValidatedProfileValues();
    if (!validated) return;
    const trimmedName = serverName.trim();
    if (!trimmedName) {
      setError("Server name is required");
      return;
    }

    const headerMap = normalizedHeaders.reduce(
      (acc, header) => {
        acc[header.key] = header.value;
        return acc;
      },
      {} as Record<string, string>,
    );

    const scopesArray = draft.scopes
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);

    const formData: ServerFormData = {
      name: trimmedName,
      type: "http",
      url: validated.trimmedUrl,
      headers: Object.keys(headerMap).length ? headerMap : undefined,
      useOAuth: true,
      oauthScopes: scopesArray,
      clientId: validated.trimmedClientId || undefined,
      clientSecret: validated.trimmedClientSecret || undefined,
    };

    onSave({
      formData,
      profile: {
        serverUrl: validated.trimmedUrl,
        clientId: validated.trimmedClientId,
        clientSecret: validated.trimmedClientSecret,
        scopes: draft.scopes.trim(),
        customHeaders: normalizedHeaders,
        protocolVersion: draft.protocolVersion,
        registrationStrategy: draft.registrationStrategy,
      },
    });
    onOpenChange(false);
  };

  const handleProtocolChange = (value: OAuthProtocolVersion) => {
    setDraft((prev) => {
      const supported = getSupportedRegistrationStrategies(value);
      const nextRegistration = supported.includes(prev.registrationStrategy)
        ? prev.registrationStrategy
        : (getDefaultRegistrationStrategy(value) as OAuthRegistrationStrategy);

      return {
        ...prev,
        protocolVersion: value,
        registrationStrategy: nextRegistration,
      };
    });
  };

  const updateHeaderRow = (
    id: string,
    field: "key" | "value",
    value: string,
  ) => {
    setHeaderRows((rows) =>
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              [field]: value,
            }
          : row,
      ),
    );
  };

  const removeHeaderRow = (id: string) => {
    setHeaderRows((rows) => {
      const updated = rows.filter((row) => row.id !== id);
      return updated.length ? updated : [createHeaderRow()];
    });
  };

  const addHeaderRow = () => {
    setHeaderRows((rows) => [...rows, createHeaderRow()]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Configure Server to Test</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label
              htmlFor="oauth-profile-name"
              className="text-xs font-semibold text-muted-foreground"
            >
              Server Name
            </Label>
            <Input
              id="oauth-profile-name"
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
              placeholder="oauth-flow-target"
              required
            />
          </div>
          <div className="space-y-6 max-h-[65vh] overflow-y-auto pr-1 pb-4">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label
                  htmlFor="oauth-profile-server-url"
                  className="text-xs font-semibold text-muted-foreground"
                >
                  Server URL
                </Label>
                <Input
                  id="oauth-profile-server-url"
                  value={draft.serverUrl}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      serverUrl: event.target.value,
                    }))
                  }
                  placeholder="https://example.com"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  required
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label
                    htmlFor="oauth-profile-protocol"
                    className="text-xs font-semibold text-muted-foreground"
                  >
                    Protocol
                  </Label>
                  <Select
                    value={draft.protocolVersion}
                    onValueChange={(value) =>
                      handleProtocolChange(value as OAuthProtocolVersion)
                    }
                  >
                    <SelectTrigger
                      id="oauth-profile-protocol"
                      className="h-9 text-sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2025-03-26" className="text-xs">
                        2025-03-26
                      </SelectItem>
                      <SelectItem value="2025-06-18" className="text-xs">
                        2025-06-18 (Latest)
                      </SelectItem>
                      <SelectItem value="2025-11-25" className="text-xs">
                        2025-11-25 (Draft)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label
                    htmlFor="oauth-profile-registration"
                    className="text-xs font-semibold text-muted-foreground"
                  >
                    Registration
                  </Label>
                  <Select
                    value={draft.registrationStrategy}
                    onValueChange={(value) =>
                      setDraft((prev) => ({
                        ...prev,
                        registrationStrategy:
                          value as OAuthRegistrationStrategy,
                      }))
                    }
                  >
                    <SelectTrigger
                      id="oauth-profile-registration"
                      className="h-9 text-sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {supportedStrategies.map((strategy) => (
                        <SelectItem
                          key={strategy}
                          value={strategy}
                          className="text-xs"
                        >
                          {describeRegistrationStrategy(strategy)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border">
              <Accordion type="single" collapsible defaultValue="">
                <AccordionItem value="advanced" className="border-none">
                  <AccordionTrigger className="px-4 py-3 cursor-pointer">
                    <span className="text-sm font-medium">
                      Advanced settings (optional)
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="px-4 space-y-4 pb-4">
                    <div className="space-y-2">
                      <Label
                        htmlFor="oauth-profile-scopes"
                        className="text-xs text-muted-foreground"
                      >
                        Scopes
                      </Label>
                      <Textarea
                        id="oauth-profile-scopes"
                        value={draft.scopes}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            scopes: event.target.value,
                          }))
                        }
                        placeholder="openid profile email"
                        rows={1}
                      />
                    </div>

                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground">
                        Client credentials
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Used for pre-registered flows or when dynamic
                        registration is skipped.
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <Input
                          value={draft.clientId}
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              clientId: event.target.value,
                            }))
                          }
                          placeholder="Client ID"
                          spellCheck={false}
                          autoComplete="off"
                        />
                        <Input
                          type="password"
                          value={draft.clientSecret}
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              clientSecret: event.target.value,
                            }))
                          }
                          placeholder="Client Secret (optional)"
                          autoComplete="off"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground">
                        Custom headers
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Added to discovery and token requests (e.g. API keys).
                      </p>
                      <div className="space-y-2">
                        {headerRows.map((row) => (
                          <div key={row.id} className="flex gap-2">
                            <Input
                              value={row.key}
                              onChange={(event) =>
                                updateHeaderRow(
                                  row.id,
                                  "key",
                                  event.target.value,
                                )
                              }
                              placeholder="Header-Name"
                              className="text-xs"
                            />
                            <Input
                              value={row.value}
                              onChange={(event) =>
                                updateHeaderRow(
                                  row.id,
                                  "value",
                                  event.target.value,
                                )
                              }
                              placeholder="header-value"
                              className="text-xs"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeHeaderRow(row.id)}
                              className="h-8 w-8"
                              aria-label="Remove header"
                            >
                              ×
                            </Button>
                          </div>
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full text-xs"
                        onClick={addHeaderRow}
                      >
                        + Add header
                      </Button>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>

            {error ? (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Save configuration</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

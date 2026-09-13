import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { useState } from "react";
import { Camera, Loader2, Save } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { useSettingsDraft } from "../settings/SettingsDraftProvider";
import { OrganizationUsageSummary } from "./OrganizationUsageSummary";
import { ErrorBoundary } from "../ui/error-boundary";

export function OrganizationGeneralDetails({
  organizationId,
  name,
  logoUrl,
  canEdit,
  isUploading,
  onUpload,
  onSave,
}: {
  organizationId?: string;
  name: string;
  logoUrl?: string;
  canEdit: boolean;
  isUploading: boolean;
  onUpload: () => void;
  onSave: (name: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const value = draft ?? name;
  const dirty = value !== name;
  useSettingsDraft(
    dirty,
    () => {
      setDraft(null);
      setError("");
    },
    saving || isUploading,
  );
  return (
    <div className="max-w-2xl space-y-7 text-accent-foreground">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">General</h1>
        <SettingsPageDescription>
          Manage your organization’s name and logo.
        </SettingsPageDescription>
      </header>
      <div className="flex items-center gap-4 border-b border-border pb-7">
        <Avatar className="size-20 shrink-0 rounded-xl">
          <AvatarImage src={logoUrl} alt={name} />
          <AvatarFallback className="rounded-xl bg-accent text-2xl text-accent-foreground">
            {name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="space-y-2">
          <div>
            <h2 className="text-sm font-semibold">Organization logo</h2>
            <p className="text-xs text-foreground">
              Choose an image under 5 MB.
            </p>
          </div>
          {canEdit && (
            <Button
              onClick={onUpload}
              disabled={isUploading || saving}
              variant="secondary"
              className="bg-foreground font-semibold text-background hover:bg-foreground/90"
            >
              {isUploading ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Camera aria-hidden="true" className="size-4" />
              )}
              {isUploading ? "Uploading…" : "Upload organization logo"}
            </Button>
          )}
        </div>
      </div>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canEdit || saving || !dirty) return;
          if (!value.trim()) {
            setError("Enter an organization name.");
            return;
          }
          setSaving(true);
          setError("");
          setSaved(false);
          try {
            await onSave(value.trim());
            setDraft(null);
            setSaved(true);
          } catch {
            setError("Could not save the organization name. Please try again.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="organization-name" className="text-accent-foreground">
            Organization name
          </Label>
          <Input
            id="organization-name"
            value={value}
            readOnly={!canEdit}
            disabled={saving}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            className="text-accent-foreground"
          />
          {!canEdit && (
            <p className="text-xs text-foreground">
              Only organization owners and admins can change these details.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {canEdit && (
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              variant="secondary"
              disabled={!dirty || saving || isUploading}
              className="bg-foreground font-semibold text-background hover:bg-foreground/90"
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Save aria-hidden="true" className="size-4" />
              )}
              {saving ? "Saving…" : "Save changes"}
            </Button>
            {saved && (
              <p role="status" className="text-sm">
                Changes saved.
              </p>
            )}
          </div>
        )}
      </form>
      {organizationId && (
        <ErrorBoundary
          key={organizationId}
          name="organization-usage-summary"
          fallback={
            <p className="text-sm text-foreground">
              Usage summary is temporarily unavailable.
            </p>
          }
        >
          <OrganizationUsageSummary organizationId={organizationId} />
        </ErrorBoundary>
      )}
    </div>
  );
}

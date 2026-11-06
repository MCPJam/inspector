import { useState } from "react";
import { useMutation } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useSoftQuery } from "@/hooks/use-soft-query";
import {
  saveWorkDomain,
  saveWorkDiscovery,
  type WorkDomainSettings,
} from "@/hooks/useWorkOrganization";
import { messageOf } from "@/hooks/useOrgScopedWrite";
import { useSettingsDraft } from "../settings/SettingsDraftProvider";

export function WorkOrganizationSettings({
  organizationId,
}: {
  organizationId: string;
}) {
  const { data, error } = useSoftQuery<WorkDomainSettings | null>(
    "workOrganizationDirectory:getSettings",
    { organizationId },
  );
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        Email domain settings could not load. Reload this page to try again.
      </p>
    );
  if (!data) return null;
  return (
    <WorkDomainForm
      key={`${organizationId}:${data.domain}`}
      organizationId={organizationId}
      policy={data}
    />
  );
}

function WorkDomainForm({
  organizationId,
  policy,
}: {
  organizationId: string;
  policy: WorkDomainSettings;
}) {
  const [draft, setDraft] = useState<{
    organizationId: string;
    automaticJoining: boolean;
    discoverable: boolean;
    expectedRevision: number;
    expectedDiscoveryRevision: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMutation(saveWorkDomain);
  const saveDiscovery = useMutation(saveWorkDiscovery);
  const value = draft ?? {
    organizationId: policy.organizationId,
    automaticJoining: policy.automaticJoining,
    discoverable: policy.discoverable,
    expectedRevision: policy.revision,
    expectedDiscoveryRevision: policy.discoveryRevision,
  };
  useSettingsDraft(
    draft !== null,
    () => {
      setDraft(null);
      setError("");
    },
    saving,
  );
  const update = (next: Partial<typeof value>) => {
    setDraft({ ...value, ...next });
    setSaved(false);
  };
  return (
    <section
      className="mt-7 space-y-5 border-t border-border pt-5"
      aria-labelledby="email-domain-heading"
    >
      <div className="space-y-1">
        <h2 id="email-domain-heading" className="text-lg font-semibold">
          Email domain
        </h2>
        <p className="text-sm text-foreground">
          {policy.canManageDefault ? (
            <>
              Choose where new teammates with verified {policy.domain} emails
              join.
            </>
          ) : (
            <>
              Control whether coworkers with verified {policy.domain} emails can
              find this organization.
            </>
          )}
        </p>
      </div>
      {policy.canManageDefault && (
        <>
          <div className="space-y-2">
            <Label htmlFor="work-default">Default work organization</Label>
            <Select
              value={value.organizationId}
              disabled={saving}
              onValueChange={(organizationId) => update({ organizationId })}
            >
              <SelectTrigger id="work-default" className="w-full sm:max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {policy.options.map((option) => (
                  <SelectItem
                    key={option.organizationId}
                    value={option.organizationId}
                  >
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
            <div>
              <Label htmlFor="work-auto-join">
                Automatically join new teammates
              </Label>
              <p className="text-sm text-foreground">
                New signups with verified work emails join as members.
              </p>
            </div>
            <Switch
              id="work-auto-join"
              checked={value.automaticJoining}
              disabled={saving}
              onCheckedChange={(automaticJoining) =>
                update({ automaticJoining })
              }
            />
          </div>
        </>
      )}
      <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
        <div>
          <Label htmlFor="work-discovery">
            Let coworkers discover this organization
          </Label>
          <p className="text-sm text-foreground">
            Coworkers with verified {policy.domain} emails can see this
            organization’s name. Discovery does not grant access.
          </p>
        </div>
        <Switch
          id="work-discovery"
          checked={value.discoverable}
          disabled={saving}
          onCheckedChange={(discoverable) => update({ discoverable })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={!draft || saving}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              if (policy.canManageDefault)
                await save({
                  domain: policy.domain,
                  ...value,
                  settingsOrganizationId: organizationId,
                });
              else
                await saveDiscovery({
                  organizationId,
                  discoverable: value.discoverable,
                  expectedRevision: value.expectedDiscoveryRevision,
                });
              setDraft(null);
              setSaved(true);
            } catch (cause) {
              setError(messageOf(cause));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {saved && (
          <p role="status" className="text-sm">
            Email domain settings saved.
          </p>
        )}
      </div>
      {error && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">
            {error} Your changes are kept here.
          </p>
          {policy.canManageDefault && (
            <p>
              Current default:{" "}
              {
                policy.options.find(
                  (option) => option.organizationId === policy.organizationId,
                )?.name
              }
              . Automatic joining is {policy.automaticJoining ? "on" : "off"}.
            </p>
          )}
          {!policy.canManageDefault && (
            <p>Discovery is currently {policy.discoverable ? "on" : "off"}.</p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({
                ...value,
                expectedRevision: policy.revision,
                expectedDiscoveryRevision: policy.discoveryRevision,
              });
              setError("");
            }}
          >
            Keep changes for retry
          </Button>
        </div>
      )}
      {policy.canManageDefault && (
        <p className="text-xs text-foreground">
          Paid seats still require owner-approved payment.
        </p>
      )}
    </section>
  );
}

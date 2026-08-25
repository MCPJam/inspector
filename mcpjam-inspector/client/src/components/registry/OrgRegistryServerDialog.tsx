import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Badge } from "@mcpjam/design-system/badge";
import { Loader2, ShieldCheck, Unlock } from "lucide-react";
import {
  deriveOrgRegistryServer,
  snapshotFromDerivedFacts,
  type DerivedServerFacts,
  type OrgRegistryDerivedSnapshot,
} from "@/lib/apis/web/org-registry-api";
import { WebApiError } from "@/lib/apis/web/base";

/**
 * Add or edit an entry on the organization's registry shelf.
 *
 * TWO STEPS, AND THE FIRST ONE IS THE POINT. Paste an address; the Inspector
 * probes it and fills the form in from what the server actually said. Version
 * and auth posture are then READ-ONLY — they are facts about the server, and a
 * field a person can type into is a field that will eventually disagree with
 * the thing it describes.
 *
 * Three ways in, one form:
 *
 *   paste   — step "url", then "confirm" once the probe answers.
 *   promote — opens straight at "confirm" with facts read off the connected
 *             server's `initializationInfo`. No probe: the browser is already
 *             talking to it, so asking the server again would be slower and no
 *             more true.
 *   edit    — opens at "confirm" with the stored row. If its URL changes,
 *             saving re-probes before persisting so the facts stay paired with
 *             the address they describe.
 *
 * A REFUSAL IS NOT AN ERROR TO RETRY. The route answers a blocked address with
 * one generic sentence and a 400, and this dialog shows exactly that sentence
 * and leaves the URL where it is. Anything more helpful would be helping the
 * wrong person.
 */

export interface OrgRegistryDialogSeed {
  /** Present when editing an existing row. */
  registryServerId?: string;
  displayName: string;
  description?: string;
  url: string;
  useOAuth?: boolean;
  oauthScopes?: string[];
  derived?: OrgRegistryDerivedSnapshot;
  /** Set by PROMOTE: the `servers` row this entry came from. */
  sourceServerId?: string;
}

export interface OrgRegistryDialogSubmission {
  registryServerId?: string;
  displayName: string;
  description?: string;
  url: string;
  useOAuth?: boolean;
  oauthScopes?: string[];
  /** Absent when no probe has run — see the note at the submit site. */
  derived?: OrgRegistryDerivedSnapshot;
  sourceServerId?: string;
}

export interface OrgRegistryServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  /**
   * Absent ⇒ the paste flow starts at the URL step. Present ⇒ promote or
   * edit, opening at the confirm step with these values.
   */
  seed?: OrgRegistryDialogSeed | null;
  /** Rejecting with an Error puts its message inline; the dialog stays open. */
  onSubmit: (submission: OrgRegistryDialogSubmission) => Promise<void>;
}

type Step = "url" | "confirm";

function messageFor(error: unknown): string {
  if (error instanceof WebApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

export function OrgRegistryServerDialog({
  open,
  onOpenChange,
  projectId,
  seed,
  onSubmit,
}: OrgRegistryServerDialogProps) {
  const isEdit = Boolean(seed?.registryServerId);
  /**
   * On PROMOTE the URL is not editable, and that is enforcement showing
   * through rather than a style choice: `addOrgRegistryServer` refuses a
   * promotion whose URL does not match the source server's own
   * ("The promoted server URL no longer matches the entry URL"). An editable
   * field here would be a field whose every edit is a dead end. Someone who
   * wants a different address wants the paste flow, which the copy says.
   */
  const isPromote = Boolean(seed?.sourceServerId) && !seed?.registryServerId;
  const [step, setStep] = useState<Step>(seed ? "confirm" : "url");
  const [url, setUrl] = useState(seed?.url ?? "");
  const [displayName, setDisplayName] = useState(seed?.displayName ?? "");
  const [description, setDescription] = useState(seed?.description ?? "");
  const [derived, setDerived] = useState<OrgRegistryDerivedSnapshot | null>(
    seed?.derived ?? null
  );
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed on OPEN rather than on every seed change: a parent that rebuilds
  // the seed object each render would otherwise wipe what someone is typing.
  useEffect(() => {
    if (!open) return;
    setStep(seed ? "confirm" : "url");
    setUrl(seed?.url ?? "");
    setDisplayName(seed?.displayName ?? "");
    setDescription(seed?.description ?? "");
    setDerived(seed?.derived ?? null);
    setError(null);
    setProbing(false);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const authRequired = derived?.authRequired ?? seed?.useOAuth ?? false;
  const canRegisterDynamically =
    (derived?.supportsDcr ?? false) || (derived?.supportsCimd ?? false);
  /**
   * Mirrors the directory badge's rule (`requiresPreregisteredClient`): only
   * a server that demands auth AND resolved no way to register a client on
   * the fly needs one handed to it in advance. A row with no probe verdict
   * says nothing rather than accusing the server of something.
   */
  const requiresPreregisteredClient =
    authRequired && derived !== null && !canRegisterDynamically;

  const canProbe = url.trim().length > 0 && !probing && Boolean(projectId);
  const canSave =
    displayName.trim().length > 0 &&
    url.trim().length > 0 &&
    (isEdit || derived !== null) &&
    !saving;

  async function handleProbe() {
    if (!projectId) return;
    setProbing(true);
    setError(null);
    try {
      const facts: DerivedServerFacts = await deriveOrgRegistryServer({
        url: url.trim(),
        projectId,
      });
      const snapshot = snapshotFromDerivedFacts(facts);
      setDerived(snapshot);
      // The server's own title is the better label when it published one; its
      // `name` is usually a package id ("example-mcp"), which is a worse thing
      // to put on a card than the address the person just typed.
      setDisplayName(facts.title ?? facts.serverName ?? displayName);
      setUrl(facts.endpointUrl);
      setStep("confirm");
    } catch (probeError) {
      setError(messageFor(probeError));
    } finally {
      setProbing(false);
    }
  }

  async function handleSave() {
    if (!isEdit && !derived) {
      setError("Check the server before adding it to the registry.");
      return;
    }
    setSaving(true);
    setError(null);
    let submissionDerived = derived;
    let submissionUrl = url.trim();
    let submissionAuthRequired = authRequired;
    try {
      // A URL edit changes what the read-only facts describe. Re-probe before
      // saving so the stored snapshot cannot silently belong to the old URL.
      if (isEdit && submissionUrl !== seed?.url.trim()) {
        if (!projectId) {
          throw new Error("Select a project before changing the server URL.");
        }
        setProbing(true);
        const facts = await deriveOrgRegistryServer({
          url: submissionUrl,
          projectId,
        });
        submissionDerived = snapshotFromDerivedFacts(facts);
        submissionUrl = facts.endpointUrl;
        submissionAuthRequired = submissionDerived.authRequired ?? false;
        setDerived(submissionDerived);
        setUrl(submissionUrl);
      }
      await onSubmit({
        registryServerId: seed?.registryServerId,
        displayName: displayName.trim(),
        description: description.trim() || undefined,
        url: submissionUrl,
        // `authRequired` is what the server said; `useOAuth` is what we will
        // do about it. They are the same decision here, and keeping the
        // stored value derived from the probe is what makes a later re-probe
        // able to correct it.
        useOAuth: submissionAuthRequired,
        oauthScopes: seed?.oauthScopes,
        // NEVER synthesize a snapshot. Readers treat the presence of
        // `derived` as proof a probe returned a verdict — the card asserts
        // "Requires pre-registered client" whenever it exists and names no
        // registration strategy — so a minted one would make an unprobed
        // entry accuse its server of something nothing established. The paste
        // flow always probes and promote always seeds, so this is guarding
        // the field's meaning rather than a live path.
        derived: submissionDerived ?? undefined,
        sourceServerId: seed?.sourceServerId,
      });
      onOpenChange(false);
    } catch (saveError) {
      setError(messageFor(saveError));
    } finally {
      setProbing(false);
      setSaving(false);
    }
  }

  const title = isEdit
    ? "Edit registry entry"
    : seed?.sourceServerId
    ? "Add to organization registry"
    : "Add a server to your organization";

  const versionLabel = useMemo(
    () => derived?.serverVersion ?? null,
    [derived?.serverVersion]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {step === "url"
              ? "Paste the server's address. We'll read its name, version and sign-in requirements straight off it."
              : "Everyone in your organization will see this entry and can connect it from their own projects."}
          </DialogDescription>
        </DialogHeader>

        {step === "url" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-registry-url">Server URL</Label>
              <Input
                id="org-registry-url"
                name="url"
                type="url"
                autoComplete="url"
                value={url}
                placeholder="https://mcp.example.com/mcp"
                autoFocus
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canProbe) void handleProbe();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Remote HTTP servers only. Organization entries carry the address
                and the sign-in method — never a shared secret.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="org-registry-name">Name</Label>
              <Input
                id="org-registry-name"
                name="displayName"
                value={displayName}
                autoFocus
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-registry-description">
                Description{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="org-registry-description"
                name="description"
                value={description}
                rows={2}
                placeholder="What your team uses this server for."
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-registry-confirm-url">Server URL</Label>
              <Input
                id="org-registry-confirm-url"
                name="url"
                type="url"
                autoComplete="url"
                value={url}
                readOnly={isPromote}
                aria-readonly={isPromote}
                className={isPromote ? "text-muted-foreground" : undefined}
                onChange={(event) => setUrl(event.target.value)}
              />
              {isPromote && (
                <p className="text-xs text-muted-foreground">
                  Taken from the connected server. Point the org at a different
                  address by adding it with a link instead.
                </p>
              )}
            </div>

            {/* Read-only: facts about the server, not fields about the entry. */}
            <div className="flex flex-wrap items-center gap-1.5">
              {versionLabel && (
                <Badge variant="secondary" className="text-[10px]">
                  v{versionLabel}
                </Badge>
              )}
              <Badge variant="secondary" className="text-[10px] gap-1">
                {authRequired ? (
                  <>
                    <ShieldCheck className="h-3 w-3" /> Requires sign-in
                  </>
                ) : (
                  <>
                    <Unlock className="h-3 w-3" /> Open
                  </>
                )}
              </Badge>
              {requiresPreregisteredClient && (
                <Badge variant="outline" className="text-[10px]">
                  Requires pre-registered client
                </Badge>
              )}
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="text-xs text-destructive whitespace-pre-wrap"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {step === "url" ? (
            <Button type="button" disabled={!canProbe} onClick={handleProbe}>
              {probing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {probing ? "Checking server…" : "Continue"}
            </Button>
          ) : (
            <Button type="button" disabled={!canSave} onClick={handleSave}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isEdit ? "Save changes" : "Add to registry"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

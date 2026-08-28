import { useMemo, useState } from "react";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  useCreateProjectSecret,
  useDeleteProjectSecret,
  useProjectSecrets,
  useUpdateProjectSecret,
  type ProjectSecretView,
  type SecretDelivery,
  type SecretSharing,
} from "@/hooks/useProjectSecrets";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { environmentLabel } from "@/lib/environment-label";

/**
 * Project secrets — the credentials a real workflow needs, managed in one place.
 *
 * ## What this screen can and cannot show
 *
 * It never shows a value, and there is no state in this component that holds
 * one past a submit. The create and rotate dialogs clear their field on success
 * and say plainly that the value cannot be read back, because the alternative —
 * a masked field that looks like it is holding something — invites people to
 * come back looking for it.
 *
 * ## The delivery choice is the point of the form
 *
 * Brokered and materialized are not "secure" and "less secure"; they answer
 * different questions, and picking wrong produces a workflow that silently does
 * not work. A brokered secret is invisible to `echo $NAME` and unreadable by a
 * CLI; a materialized one is printed by `env`. The radio group says both things
 * where the choice is made rather than in documentation nobody opens.
 */
export function ProjectSecretsSection({
  projectId,
  canManageShared,
}: {
  projectId: string;
  /**
   * Whether this member may create or edit PROJECT-SHARED secrets (project
   * admin). Personal secrets are owner-managed and always available — which is
   * why a non-admin sees the section rather than an empty screen.
   */
  canManageShared: boolean;
}) {
  const secrets = useProjectSecrets(projectId);
  const environments = useProjectEnvironments(projectId);
  const deleteSecret = useDeleteProjectSecret();

  const [createOpen, setCreateOpen] = useState(false);
  const [rotating, setRotating] = useState<ProjectSecretView | null>(null);
  const [deleting, setDeleting] = useState<ProjectSecretView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Which environments would stop delivering this secret. Shown in the delete
   * confirm as INFORMATION, not as a blocker: revocation is never gated on
   * cleanup, and a user revoking a leaked credential must not be told to go
   * edit five environments first.
   */
  const environmentsUsing = useMemo(() => {
    if (!deleting || !environments) return [];
    return environments.filter((environment) =>
      environment.secretSelection?.secretIds.includes(deleting.secretId),
    );
  }, [deleting, environments]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await deleteSecret({ projectId, secretId: deleting.secretId });
      setDeleting(null);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Failed to delete the secret.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Secrets</h2>
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" /> New secret
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Credentials a workflow needs — a <code>stripe</code> run,{" "}
        <code>gh</code>, <code>psql</code>. Select them on an environment to
        grant them to the runs it launches. Values are write-only: once saved,
        nobody can read one back, here or through the API.
      </p>

      <div className="rounded-md border">
        {secrets === undefined ? (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading secrets…
          </div>
        ) : secrets.length === 0 ? (
          <p className="px-4 py-6 text-xs italic text-muted-foreground">
            No secrets yet. Add one, then select it on the environment whose
            runs should receive it.
          </p>
        ) : (
          <ul className="divide-y">
            {secrets.map((secret) => (
              <li
                key={secret.secretId}
                className="flex items-center gap-3 px-4 py-3"
              >
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-sm">
                    {secret.name}
                  </span>
                  {secret.description ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {secret.description}
                    </span>
                  ) : null}
                </div>
                <DeliveryBadge secret={secret} />
                <Badge variant="outline" className="shrink-0">
                  {secret.sharing === "project" ? "Project" : "Personal"}
                </Badge>
                <span className="w-36 shrink-0 text-right text-xs text-muted-foreground">
                  {secret.lastDeliveredAt
                    ? `Delivered ${new Date(
                        secret.lastDeliveredAt,
                      ).toLocaleDateString()}`
                    : "Never delivered"}
                </span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit(secret, canManageShared)}
                    onClick={() => setRotating(secret)}
                    title="Rotate this secret's value"
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit(secret, canManageShared)}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(secret);
                    }}
                    title="Revoke this secret"
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateSecretDialog
        projectId={projectId}
        open={createOpen}
        canManageShared={canManageShared}
        onOpenChange={setCreateOpen}
      />

      <RotateSecretDialog
        projectId={projectId}
        secret={rotating}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {deleting?.name ?? "this secret"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  The stored value is deleted permanently. Runs already in
                  flight keep the credential they were handed; every new run
                  gets nothing.
                </p>
                {environmentsUsing.length > 0 ? (
                  <p>
                    {environmentsUsing.length === 1
                      ? "One environment selects it and will stop delivering it:"
                      : `${environmentsUsing.length} environments select it and will stop delivering it:`}{" "}
                    <span className="font-medium">
                      {environmentsUsing
                        .map((environment) => environmentLabel(environment))
                        .join(", ")}
                    </span>
                    .
                  </p>
                ) : null}
                {deleteError ? (
                  <p className="text-destructive">{deleteError}</p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                // Kept open until the action settles so a failure is visible
                // here rather than vanishing with the dialog.
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {busy ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A shared secret needs admin; a personal one is its owner's. */
function canEdit(secret: ProjectSecretView, canManageShared: boolean): boolean {
  return secret.sharing === "project" ? canManageShared : secret.isOwner;
}

/**
 * The delivery badge, with the sentence that stops the wrong choice from being
 * discovered inside a sandbox.
 */
function DeliveryBadge({ secret }: { secret: ProjectSecretView }) {
  if (secret.delivery === "materialized") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="shrink-0 gap-1">
            <AlertTriangle className="size-3" /> materialized
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[280px]">
          <p className="text-xs leading-snug">
            The value is a real environment variable inside the sandbox, which
            is what makes a CLI able to read it — and what makes it visible to
            anything else in the box, including <code>env</code>. Extractable by
            design.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="shrink-0 gap-1">
          <ShieldCheck className="size-3" /> brokered
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[300px]">
        <p className="text-xs leading-snug">
          Injected as <code>{secret.brokerHeader ?? "a header"}</code> on{" "}
          {(secret.brokerHosts ?? []).join(", ") || "its bound hosts"} by the
          egress proxy, outside the sandbox. The box never holds the value — but
          anything in the box can still CALL those hosts while the run is live.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Shared broker binding fields, used by both dialogs. */
function BrokerFields({
  hosts,
  header,
  template,
  onHosts,
  onHeader,
  onTemplate,
  disabled,
}: {
  hosts: string;
  header: string;
  template: string;
  onHosts: (next: string) => void;
  onHeader: (next: string) => void;
  onTemplate: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <Label htmlFor="secret-hosts">Hosts</Label>
        <Input
          id="secret-hosts"
          value={hosts}
          disabled={disabled}
          placeholder="api.stripe.com"
          onChange={(event) => onHosts(event.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          Comma-separated, exact hostnames. No scheme, port, or wildcard — the
          proxy matches a host, and a URL installs a rule that never fires.
          HTTPS only.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="secret-header">Header</Label>
        <Input
          id="secret-header"
          value={header}
          disabled={disabled}
          placeholder="Authorization"
          onChange={(event) => onHeader(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="secret-template">Header value</Label>
        <Input
          id="secret-template"
          value={template}
          disabled={disabled}
          placeholder="Bearer {}"
          onChange={(event) => onTemplate(event.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          {template.includes("{}") ? (
            <>
              Sent as{" "}
              <code>
                {header || "Header"}: {template.replace("{}", "•••••")}
              </code>
            </>
          ) : (
            <>
              Must contain <code>{"{}"}</code>, which is replaced with the
              secret. Without it the header never carries the credential.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/** Split the comma-separated host field, dropping blanks. */
function parseHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

function CreateSecretDialog({
  projectId,
  open,
  canManageShared,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  canManageShared: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createSecret = useCreateProjectSecret();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [delivery, setDelivery] = useState<SecretDelivery>("brokered");
  const [hosts, setHosts] = useState("");
  const [header, setHeader] = useState("Authorization");
  const [template, setTemplate] = useState("Bearer {}");
  // Defaults to `project` because a secret a team creates is normally a team
  // secret — but only when this member could actually create one. A non-admin
  // defaulted to `project` would fill the form and then be refused at submit.
  const [sharing, setSharing] = useState<SecretSharing>(
    canManageShared ? "project" : "user",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setValue("");
    setDescription("");
    setDelivery("brokered");
    setHosts("");
    setHeader("Authorization");
    setTemplate("Bearer {}");
    setSharing(canManageShared ? "project" : "user");
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createSecret({
        projectId,
        name,
        value,
        ...(description.trim() ? { description: description.trim() } : {}),
        delivery,
        ...(delivery === "brokered"
          ? {
              brokerHosts: parseHosts(hosts),
              brokerHeader: header.trim(),
              brokerTemplate: template,
            }
          : {}),
        sharing,
      });
      // The value is gone from this process the moment the dialog closes, and
      // nothing can bring it back — which is why the field is cleared here
      // rather than left populated "in case they want to edit it".
      reset();
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to create the secret.",
      );
    } finally {
      setBusy(false);
    }
  };

  // Uppercased as you type: the name IS an environment-variable identifier, and
  // silently rejecting `stripe_api_key` at submit teaches nothing.
  const onName = (raw: string) =>
    setName(raw.toUpperCase().replace(/[^A-Z0-9_]/g, "_"));

  const nameValid = /^[A-Z_][A-Z0-9_]*$/.test(name);
  const brokerValid =
    delivery === "materialized" ||
    (parseHosts(hosts).length > 0 &&
      header.trim().length > 0 &&
      template.includes("{}"));
  const canSubmit = nameValid && value.length > 0 && brokerValid && !busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New secret</DialogTitle>
          <DialogDescription>
            The value is stored encrypted and cannot be read back — not here,
            not through the API. To change it later you replace it.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              id="secret-name"
              value={name}
              placeholder="STRIPE_API_KEY"
              className="font-mono"
              onChange={(event) => onName(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              The environment-variable name. Immutable — to rename it later you
              create a new secret and delete this one.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="secret-value">Value</Label>
            <Textarea
              id="secret-value"
              value={value}
              rows={3}
              className="font-mono text-xs"
              onChange={(event) => setValue(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="secret-description">Description</Label>
            <Input
              id="secret-description"
              value={description}
              placeholder="What this credential is for"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Delivery</Label>
            <RadioGroup
              value={delivery}
              onValueChange={(next) => setDelivery(next as SecretDelivery)}
              className="gap-2"
            >
              <Label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
                <RadioGroupItem value="brokered" className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    Brokered (recommended)
                  </span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    The egress proxy adds the header outside the sandbox, so the
                    box never holds the value and an agent has nothing to
                    exfiltrate. It prevents extraction, not use — anything in
                    the box can still call the bound hosts. HTTPS APIs only, and{" "}
                    <strong>a CLI cannot read it</strong>.
                  </span>
                </span>
              </Label>
              <Label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
                <RadioGroupItem value="materialized" className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Materialized</span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    A real environment variable in the sandbox — which is what a
                    CLI like <code>stripe</code> needs, and what makes the value{" "}
                    <strong>visible inside the box</strong> to <code>env</code>{" "}
                    and to anything the agent runs. Pick this when a command has
                    to read the credential itself.
                  </span>
                </span>
              </Label>
            </RadioGroup>
          </div>

          {delivery === "brokered" ? (
            <BrokerFields
              hosts={hosts}
              header={header}
              template={template}
              onHosts={setHosts}
              onHeader={setHeader}
              onTemplate={setTemplate}
            />
          ) : null}

          <div className="space-y-2">
            <Label>Who gets it</Label>
            <RadioGroup
              value={sharing}
              onValueChange={(next) => setSharing(next as SecretSharing)}
              className="gap-2"
            >
              <Label
                className={
                  canManageShared
                    ? "flex cursor-pointer items-start gap-2 rounded-md border p-3"
                    : "flex cursor-not-allowed items-start gap-2 rounded-md border p-3 opacity-60"
                }
              >
                <RadioGroupItem
                  value="project"
                  className="mt-0.5"
                  disabled={!canManageShared}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Project</span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {canManageShared
                      ? "Delivered in every member's sessions of any environment that selects it."
                      : "Only project admins can create a project-shared secret."}
                  </span>
                </span>
              </Label>
              <Label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
                <RadioGroupItem value="user" className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Personal</span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    Delivered only in sessions YOU start. A teammate running the
                    same environment simply does not receive it.
                  </span>
                </span>
              </Label>
            </RadioGroup>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rotate a value.
 *
 * VALUE ONLY. The binding is edited from the same place it was set, and mixing
 * "replace the credential" with "change where it is sent" into one dialog makes
 * the riskier of the two easy to do by accident.
 */
function RotateSecretDialog({
  projectId,
  secret,
  onOpenChange,
}: {
  projectId: string;
  secret: ProjectSecretView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const updateSecret = useUpdateProjectSecret();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!secret) return;
    setBusy(true);
    setError(null);
    try {
      await updateSecret({ projectId, secretId: secret.secretId, value });
      setValue("");
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to rotate the secret.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(next) => {
        if (!next) {
          setValue("");
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Rotate{" "}
            <span className="font-mono">{secret?.name ?? "this secret"}</span>
          </DialogTitle>
          <DialogDescription>
            The new value reaches NEW RUNS ONLY. A session already running keeps
            the credential it was handed — end it and start a new one to pick
            this up.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="rotate-value">New value</Label>
          <Textarea
            id="rotate-value"
            value={value}
            rows={3}
            className="font-mono text-xs"
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={value.length === 0 || busy}
            onClick={() => void submit()}
          >
            {busy ? "Rotating…" : "Rotate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

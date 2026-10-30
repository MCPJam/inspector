import { useEffect, useRef, useState } from "react";
import { Check, Info, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { useWorkOrganization } from "@/hooks/useWorkOrganization";
import { messageOf } from "@/hooks/useOrgScopedWrite";
import {
  buildOrganizationSwitchTarget,
  useAppNavigate,
} from "@/lib/app-navigation";
import { buildProjectPath } from "@/lib/project-route";
import { canRouteWorkSignup } from "@/lib/work-signup-navigation";

type Organization = { _id: string; name: string; seatPending?: boolean };
type Project = { _id: string; organizationId?: string; updatedAt: number };
export function WorkOrganizationNotice({
  enabled,
  activeOrganizationId,
  entry,
  organizations,
  projects,
  hidden,
}: {
  enabled: boolean;
  activeOrganizationId?: string;
  entry: string;
  organizations: Organization[];
  projects: Project[] | undefined;
  hidden?: boolean;
}) {
  const {
    data: outcome,
    acknowledge,
    retry,
    ensureProject,
  } = useWorkOrganization(enabled);
  const { data: discoverable } = useSoftQuery<
    { organizationId: string; name: string }[]
  >("workOrganizationDirectory:listDiscoverable", enabled ? {} : "skip");
  const navigate = useAppNavigate();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const interacted = useRef(false);
  useEffect(() => {
    if (hidden) {
      setOpen(false);
      setMessage("");
    }
  }, [hidden]);
  useEffect(() => {
    if (!enabled) return;
    interacted.current = false;
    const stop = () => {
      interacted.current = true;
    };
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("keydown", stop, true);
    return () => {
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("keydown", stop, true);
    };
  }, [enabled]);
  useEffect(() => {
    if (
      !outcome ||
      outcome.state !== "joined" ||
      !outcome.organizationId ||
      outcome.routedAt ||
      projects === undefined ||
      attempted.current
    )
      return;
    const organizationId = outcome.organizationId;
    if (
      !organizations.some(
        (org) => org._id === organizationId && !org.seatPending,
      )
    )
      return;
    attempted.current = true;
    let cancelled = false;
    const initial =
      window.location.pathname + window.location.search + window.location.hash;
    const run = async () => {
      try {
        if (canRouteWorkSignup(entry, initial) && !interacted.current) {
          const projectId =
            projects.find(
              (project) => project.organizationId === organizationId,
            )?._id ?? (await ensureProject({ organizationId }));
          const current =
            window.location.pathname +
            window.location.search +
            window.location.hash;
          if (!cancelled && current === initial && !interacted.current)
            navigate(buildProjectPath(projectId, "/home"), { replace: true });
        }
        if (!cancelled) await acknowledge({ action: "routed" });
      } catch (cause) {
        if (!cancelled) {
          attempted.current = false;
          setError(messageOf(cause));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      attempted.current = false;
    };
  }, [
    outcome,
    projects,
    organizations,
    entry,
    ensureProject,
    navigate,
    acknowledge,
  ]);

  if (
    hidden ||
    !outcome ||
    outcome.dismissedAt ||
    (outcome.state === "joined" &&
      outcome.organizationId !== activeOrganizationId &&
      !error)
  )
    return null;
  const others = new Map(
    organizations
      .filter(
        (org) =>
          org._id !== outcome.organizationId &&
          org._id !== outcome.personalOrganizationId,
      )
      .map((org) => [
        org._id,
        {
          organizationId: org._id,
          name: org.name,
          member: !org.seatPending,
          pending: org.seatPending,
        },
      ]),
  );
  for (const org of discoverable ?? [])
    if (
      !others.has(org.organizationId) &&
      org.organizationId !== outcome.organizationId
    )
      others.set(org.organizationId, { ...org, member: false, pending: false });
  const titles = {
    verification_required: "Verify your work email",
    lookup_pending: "Your company organization is being prepared",
    seat_required: "Your company seat needs approval",
    invitation_required: "An invitation is needed",
    unavailable: "Your company organization is unavailable",
    joined: `You joined ${outcome.organizationName}`,
  };
  const descriptions = {
    verification_required:
      "Verify your email, then try joining your company organization again.",
    lookup_pending:
      "Your personal work stays available while company lookup finishes.",
    seat_required:
      "Ask an organization owner to approve your paid seat. Your personal work stays available.",
    invitation_required:
      "Ask a company organization owner to invite you. Your personal work stays available.",
    unavailable:
      "Contact your organization owner or try again. Your personal work stays available.",
    joined: "You are a member of your company’s default organization.",
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-6 sm:px-8">
      <Alert role="status">
        {outcome.state === "joined" ? (
          <Check aria-hidden="true" />
        ) : (
          <Info aria-hidden="true" />
        )}
        <AlertTitle className="pr-8">{titles[outcome.state]}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{descriptions[outcome.state]}</p>
          {others.size > 0 && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => {
                setMessage("");
                setOpen(true);
              }}
            >
              View organizations
            </Button>
          )}
          {outcome.state !== "joined" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await retry({});
                } catch (cause) {
                  setError(messageOf(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Try again
            </Button>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {error && outcome.organizationId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const organizationId = outcome.organizationId;
                if (organizationId)
                  navigate(
                    buildOrganizationSwitchTarget(organizationId, projects),
                  );
              }}
            >
              Open organization
            </Button>
          )}
        </AlertDescription>
        <Button
          className="absolute right-2 top-2"
          variant="ghost"
          size="icon"
          aria-label="Dismiss organization notice"
          onClick={() => {
            void acknowledge({ action: "dismiss" }).catch((cause) =>
              setError(messageOf(cause)),
            );
          }}
        >
          <X />
        </Button>
      </Alert>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setMessage("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Organizations</DialogTitle>
            <DialogDescription>
              Open an organization you belong to, or ask an admin for an
              invitation.
            </DialogDescription>
          </DialogHeader>
          {[...others.values()].map((org) => (
            <div
              key={org.organizationId}
              className="flex items-center justify-between gap-4 border-b border-border py-3"
            >
              <p className="text-sm font-medium">{org.name}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (org.member) {
                    setOpen(false);
                    setMessage("");
                    navigate(
                      buildOrganizationSwitchTarget(
                        org.organizationId,
                        projects,
                      ),
                    );
                  } else
                    setMessage(
                      org.pending
                        ? "An organization owner needs to approve your paid seat."
                        : `Ask an admin of ${org.name} to invite you.`,
                    );
                }}
              >
                {org.member
                  ? "Open organization"
                  : org.pending
                    ? "Seat pending"
                    : "Ask to join"}
              </Button>
            </div>
          ))}
          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

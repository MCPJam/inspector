import { useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { UserPlus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { GuestSignInButton } from "@/components/auth/GuestSignInMessage";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import {
  buildOrganizationPath,
  routePaths,
  useAppNavigate,
} from "@/lib/app-navigation";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { toast } from "@/lib/toast";
import {
  convexErrorCode,
  decideProjectAccessRequestRef,
  getProjectAccessRequestRef,
  type AccessDecision,
  type AccessRequest,
} from "./access-request-api";
import {
  outcomeOfDecision,
  outcomeOfEarlierDecision,
  outcomeOfRefusal,
  requesterLabel,
  requestTargetName,
  type Outcome,
} from "./access-request-outcome";

const PAGE = "flex h-full min-h-0 items-center justify-center p-6";

/**
 * `/access-requests/:requestId`, where the project owner or an org owner
 * answers a request from the bell or the email. Nothing changes on load: the
 * email's `?decision=` only picks which button is primary.
 */
export function AccessRequestPage() {
  const { requestId = "" } = useParams();
  const { user, isLoading } = useInspectorAuth();
  const ready = useDbUserReady();
  const request = useQuery(
    getProjectAccessRequestRef,
    user && ready ? { requestId } : "skip",
  );

  if (!isLoading && !user) {
    return (
      <EmptyState
        icon={UserPlus}
        title="Sign in to review this request"
        description="Sign in with the account this request was sent to."
        className={PAGE}
      >
        <GuestSignInButton size="sm" location="access_request_page" />
      </EmptyState>
    );
  }
  if (request === undefined) {
    return (
      <p role="status" className={`${PAGE} text-sm text-muted-foreground`}>
        Loading the request…
      </p>
    );
  }
  if (request === null) return <UnavailableRequest />;
  return <AccessRequestReview key={request.requestId} request={request} />;
}

function UnavailableRequest() {
  const navigate = useAppNavigate();
  return (
    <EmptyState
      icon={UserPlus}
      title="This request isn't available"
      description="Only the project owner and organization owners can review it. Check that you are signed in with the account the request was sent to."
      className={PAGE}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => navigate(routePaths.root, { unscoped: true })}
      >
        Go home
      </Button>
    </EmptyState>
  );
}

function AccessRequestReview({ request }: { request: AccessRequest }) {
  const [searchParams] = useSearchParams();
  const preferred: AccessDecision =
    searchParams.get("decision") === "decline" ? "decline" : "approve";
  const decide = useMutation(decideProjectAccessRequestRef);
  const [deciding, setDeciding] = useState<AccessDecision | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [refusal, setRefusal] = useState<Outcome | null>(null);

  const submit = async (decision: AccessDecision) => {
    setDeciding(decision);
    setRefusal(null);
    try {
      const result = await decide({ requestId: request.requestId, decision });
      setOutcome(outcomeOfDecision(request, result));
    } catch (error) {
      const known = outcomeOfRefusal(convexErrorCode(error));
      if (known) setRefusal(known);
      else
        toast.error(
          getBillingErrorMessage(
            error,
            "Could not save your decision. Try again.",
            false,
          ),
        );
    } finally {
      setDeciding(null);
    }
  };

  // A decision made here wins over the reactive status: it carries whether
  // access is live or still waits on a seat payment.
  const shown =
    outcome ??
    (request.status === "pending" ? null : outcomeOfEarlierDecision(request));
  const who = requesterLabel(request);

  return (
    <div className={PAGE}>
      <div className="w-full max-w-md space-y-4" data-testid="access-request">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">
            {who} {request.project ? "asked for access to" : "asked to join"}{" "}
            {requestTargetName(request)}
          </h1>
          {request.requester.name ? (
            <p className="text-sm text-muted-foreground">
              {request.requester.email}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Requested {new Date(request.requestedAt).toLocaleString()}
          </p>
        </div>
        {shown ? (
          <OutcomeNotice
            outcome={shown}
            organizationId={request.organizationId}
          />
        ) : (
          <>
            <p className="text-sm">
              {!request.project
                ? `Approving adds ${who} to ${request.organizationName} as a member.`
                : request.requesterInOrganization
                  ? `Approving gives ${who} editor access to this project.`
                  : `Approving adds ${who} to your organization as a guest, with editor access to this project only.`}
            </p>
            {refusal ? (
              <OutcomeNotice
                outcome={refusal}
                organizationId={request.organizationId}
              />
            ) : null}
            <div className="flex gap-2">
              {(["approve", "decline"] as const).map((decision) => (
                <Button
                  key={decision}
                  type="button"
                  size="sm"
                  variant={decision === preferred ? "default" : "outline"}
                  disabled={deciding !== null}
                  onClick={() => void submit(decision)}
                >
                  {deciding === decision
                    ? "Saving…"
                    : decision === "approve"
                      ? "Approve"
                      : "Decline"}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OutcomeNotice({
  outcome,
  organizationId,
}: {
  outcome: Outcome;
  organizationId: string;
}) {
  const navigate = useAppNavigate();
  return (
    <Alert role="status" variant={outcome.billing ? "warning" : "default"}>
      <AlertTitle>{outcome.title}</AlertTitle>
      <AlertDescription>
        <p>{outcome.body}</p>
        {outcome.billing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() =>
              navigate(buildOrganizationPath(organizationId, "billing"), {
                unscoped: true,
              })
            }
          >
            Open organization billing
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

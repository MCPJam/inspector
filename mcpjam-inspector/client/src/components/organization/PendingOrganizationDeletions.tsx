import { Component, useEffect, useState, type ReactNode } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Button } from "@mcpjam/design-system/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { endOrganizationDeletion } from "@/stores/organization-deletion-store";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";

type PendingDeletion = {
  organizationId: string;
  name: string;
  purgeAfter: number;
};
const pendingRef = makeFunctionReference<
  "query",
  Record<string, never>,
  PendingDeletion[]
>("organizations:getMyPendingOrganizationDeletions");
const cancelRef = makeFunctionReference<
  "mutation",
  { organizationId: string },
  { success: boolean }
>("organizations:cancelOrganizationDeletion");

class DeletionBannerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export function PendingOrganizationDeletions() {
  return <DeletionBannerBoundary><PendingDeletionBanner /></DeletionBannerBoundary>;
}

function PendingDeletionBanner() {
  const { isAuthenticated } = useConvexAuth();
  const ready = useDbUserReady();
  const pending = useQuery(pendingRef, isAuthenticated && ready ? {} : "skip");
  const cancel = useMutation(cancelRef);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const cancelDeletion = async (organizationId: string) => {
    setCancelling(organizationId);
    try {
      await cancel({ organizationId });
      endOrganizationDeletion(organizationId);
      toast.success("Organization deletion cancelled");
    } catch (error) {
      setNow(Date.now());
      toast.error(
        convexErrMessage(error, "Could not cancel organization deletion. Try again."),
      );
    } finally {
      setCancelling(null);
    }
  };
  if (!pending?.length) return null;
  return (
    <div className="space-y-2 border-b border-border px-4 py-3">
      {pending.map((item) => (
        <Alert key={item.organizationId}>
          <AlertTitle>Deletion scheduled for {item.name}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              You can cancel until {new Date(item.purgeAfter).toLocaleString()}.
              Members cannot access this organization while deletion is pending.
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={cancelling !== null || now >= item.purgeAfter}
              onClick={() => void cancelDeletion(item.organizationId)}
            >
              {cancelling === item.organizationId
                ? "Cancelling…"
                : "Cancel deletion"}
            </Button>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

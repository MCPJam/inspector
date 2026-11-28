import type { ReactNode } from "react";
import {
  CircleAlert,
  Clock,
  Loader2,
  LogIn,
  RefreshCw,
  RotateCw,
  UserX,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@mcpjam/design-system/card";
import LoadingScreen from "@/components/LoadingScreen";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { signInAgain } from "@/lib/auth/sign-in-again";
import { reportCaught } from "@/lib/error-reporting";
import { guestSessionRefusalCopy } from "@/lib/guest-session-refusal-copy";
import {
  retryStartup,
  useStartupStatus,
  type StartupStatus,
} from "@/lib/startup-status";
import { StartupDiagnostics } from "./StartupDiagnostics";

type Action = "retry" | "signIn" | "signInAgain" | "reload";

interface Recovery {
  icon: ReactNode;
  title: string;
  description: string;
  primary: Action;
  secondary: Action[];
}

const KEEPS_SETUP = "Your local servers and settings stay on this device.";

const RECOVERY = {
  refreshFailed: {
    icon: <CircleAlert className="text-warning" />,
    title: "Could not renew your session",
    description: `MCPJam cannot open until your sign-in is renewed. Sign in again to start a new session. ${KEEPS_SETUP}`,
    primary: "signInAgain",
    secondary: ["retry", "reload"],
  },
  expired: {
    icon: <UserX className="text-warning" />,
    title: "Your session expired",
    description: `Sign in again to open MCPJam. ${KEEPS_SETUP}`,
    primary: "signInAgain",
    secondary: [],
  },
  guestFailed: {
    icon: <CircleAlert className="text-warning" />,
    title: "Could not start a guest session",
    description:
      "MCPJam needs a guest session to open without an account. Retry, or sign in to use your account.",
    primary: "retry",
    secondary: ["signIn", "reload"],
  },
  stalled: {
    icon: <Clock className="text-warning" />,
    title: "MCPJam is taking longer than usual to open",
    description:
      "Startup has not finished after 20 seconds. Reload the app to start over. If it stops here again, copy diagnostics and send them to support.",
    primary: "reload",
    secondary: ["retry", "signInAgain"],
  },
} satisfies Record<string, Recovery>;

const LABEL: Record<Action, string> = {
  retry: "Retry",
  signIn: "Sign in",
  signInAgain: "Sign in again",
  reload: "Reload app",
};

const ICON: Record<Action, ReactNode> = {
  retry: <RotateCw />,
  signIn: <LogIn />,
  signInAgain: <LogIn />,
  reload: <RefreshCw />,
};

function recoveryFor(status: StartupStatus, signedIn: boolean): Recovery {
  if (status.refusalReason) {
    // Retrying cannot help a refused guest for the rest of its window.
    const copy = guestSessionRefusalCopy(status.refusalReason);
    return {
      icon: <UserX className="text-warning" />,
      title: copy.title,
      description: copy.summary,
      primary: "signIn",
      secondary: ["reload"],
    };
  }
  if (status.failureKind === "signed_out") return RECOVERY.expired;
  if (status.failureKind) {
    return signedIn ? RECOVERY.refreshFailed : RECOVERY.guestFailed;
  }
  return RECOVERY.stalled;
}

/**
 * Shown in place of the startup spinner once startup has failed or stalled
 * (`useStartupStatus().escalated`), or when a guest is refused. One primary
 * action per state.
 */
export function StartupRecoveryCard({ status }: { status: StartupStatus }) {
  const { user, signIn, signOut } = useInspectorAuth();
  const recovery = recoveryFor(status, Boolean(user));

  const run = (action: Action) => {
    if (action === "retry") {
      retryStartup();
      return;
    }
    if (action === "reload") {
      window.location.reload();
      return;
    }
    void signInAgain({ signOut, signIn }).catch((error) =>
      reportCaught(error, {
        source: "startup_recovery_sign_in",
        level: "warning",
      }),
    );
  };

  const button = (action: Action, primary: boolean) => {
    const busy = action === "retry" && status.retrying;
    return (
      <Button
        key={action}
        variant={primary ? "default" : "outline"}
        size={primary ? "lg" : "default"}
        className={primary ? "w-full" : "flex-1"}
        disabled={busy}
        onClick={() => run(action)}
      >
        {busy ? <Loader2 className="animate-spin" /> : ICON[action]}
        {busy ? "Retrying…" : LABEL[action]}
      </Button>
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        <img
          src="/mcp_jam.svg"
          alt="MCPJam"
          draggable={false}
          className="h-12 w-12"
        />
        <Card
          role="alert"
          className="w-full gap-5"
          data-testid="startup-recovery-card"
          data-stage={status.stage}
        >
          <CardHeader className="gap-2">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 [&>svg]:size-5">{recovery.icon}</span>
              <div className="flex flex-col gap-2">
                <CardTitle className="text-base leading-snug">
                  {recovery.title}
                </CardTitle>
                <CardDescription className="leading-relaxed">
                  {recovery.description}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {button(recovery.primary, true)}
            {recovery.secondary.length > 0 && (
              <div className="flex gap-2">
                {recovery.secondary.map((action) => button(action, false))}
              </div>
            )}
          </CardContent>
          <StartupDiagnostics status={status} />
        </Card>
      </div>
    </div>
  );
}

/** A startup spinner that becomes the recovery card once startup escalates. */
export function StartupScreen({ message }: { message?: string }) {
  const status = useStartupStatus();
  if (status.escalated) return <StartupRecoveryCard status={status} />;
  return <LoadingScreen message={message} />;
}

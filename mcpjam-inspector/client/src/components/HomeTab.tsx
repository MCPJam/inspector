import { useCallback, useMemo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { useAuth } from "@workos-inc/authkit-react";
import { ArrowLeft, Plus } from "lucide-react";
import { useAppNavigate } from "@/lib/app-navigation";
import { Button } from "@mcpjam/design-system/button";
import { OrgStatsStrip } from "./home/OrgStatsStrip";
import { RecommendedServers } from "./home/RecommendedServers";
import { RecommendedClients } from "./home/RecommendedClients";
import { ProductUpdatesRow } from "./home/ProductUpdatesRow";
import { McpjamAgentHero } from "./mcpjam-agent/McpjamAgentHero";
import { McpjamAgentThread } from "./mcpjam-agent/McpjamAgentThread";

interface HomeTabProps {
  organizationId: string | null;
  projectId: string | null;
}

function getGreeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function deriveFirstName(opts: {
  workosFirst: string | null | undefined;
  fullName: string;
  email: string | null | undefined;
}): string {
  if (opts.workosFirst && opts.workosFirst.trim()) return opts.workosFirst.trim();
  const fromFull = opts.fullName.split(" ")[0]?.trim();
  if (fromFull && fromFull.length > 1) return fromFull;
  const fromEmail = opts.email?.split("@")[0]?.trim();
  if (fromEmail) return fromEmail;
  return "there";
}

function McpjamAgentTakeoverFrame({
  onBack,
  onNewChat,
  children,
}: {
  onBack: () => void;
  onNewChat: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label="Back to home"
          className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onNewChat}
          className="h-8 gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          <span>New chat</span>
        </Button>
      </div>
      {children}
    </div>
  );
}

// Mirrors the key handleSessionStart writes and McpjamAgentThread's autosubmit
// effect removes; lives here so the takeover Back / New chat handlers can
// clean up unconsumed payloads when the thread unmounts before its effect
// runs.
function clearPendingForSession(sessionId: string | null | undefined) {
  if (!sessionId || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(`mcpjam:agent-pending:${sessionId}`);
  } catch {
    // Quota/disabled storage — stale entry will be a no-op unless the user
    // returns to this session, and even then the duplicate-send is the only
    // visible regression. Not worth surfacing.
  }
}

export function HomeTab({ organizationId, projectId }: HomeTabProps) {
  const navigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get("session");
  const composeParam = searchParams.get("compose") === "1";

  const handleSessionStart = useCallback(
    (id: string, firstMessage: string) => {
      // Stash the typed prompt so the inline thread can autosubmit it on
      // mount — without this, the hero would lose the message in the
      // hero-to-thread swap. sessionStorage (not localStorage) so a stale
      // pending message can't leak across browser sessions.
      //
      // The `fresh: true` flag distinguishes "user just minted this id and
      // hit submit" from "user landed on /home?session=<id> via the Recent
      // Chat pill". Without it, the thread can't tell the two apart and
      // would replay the prompt against an already-hydrated transcript if
      // hydration hadn't committed yet on the first effect pass.
      try {
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(
            `mcpjam:agent-pending:${id}`,
            JSON.stringify({ text: firstMessage, fresh: true })
          );
        }
      } catch {
        // Ignore quota/disabled storage — worst case the user retypes.
      }
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("session", id);
          next.delete("compose");
          return next;
        },
        { replace: false }
      );
    },
    [setSearchParams]
  );

  const handleResumeSession = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("session", id);
          next.delete("compose");
          return next;
        },
        { replace: false }
      );
    },
    [setSearchParams]
  );

  const handleBackToHome = useCallback(() => {
    setSearchParams(
      (prev) => {
        // Drop any unconsumed pending payload for the session we're leaving;
        // otherwise a later resume of the same id replays the prompt and
        // re-renders the optimistic bubble over the hydrated transcript.
        clearPendingForSession(prev.get("session"));
        const next = new URLSearchParams(prev);
        next.delete("session");
        next.delete("compose");
        return next;
      },
      { replace: false }
    );
  }, [setSearchParams]);

  // "New chat" inside the takeover keeps the user on the agent surface and
  // swaps the thread for an empty composer (Hero). A session id is minted
  // only when they actually submit, mirroring the chatbox "Clear chat"
  // affordance — fresh slate without bouncing back to the greeting.
  const handleNewChat = useCallback(() => {
    setSearchParams(
      (prev) => {
        // Same rationale as handleBackToHome — drop the leaving session's
        // unconsumed pending payload so a later resume doesn't double-send.
        clearPendingForSession(prev.get("session"));
        const next = new URLSearchParams(prev);
        next.delete("session");
        next.set("compose", "1");
        return next;
      },
      { replace: false }
    );
  }, [setSearchParams]);
  const { user } = useAuth();
  const convexUser = useQuery("users:getCurrentUser" as any) as
    | { name?: string }
    | undefined;

  const data = useQuery(
    "home:getOrgHomeData" as any,
    organizationId ? ({ organizationId } as any) : "skip"
  ) as
    | {
        memberCount: number;
        projects: { _id: string; name: string; icon?: string }[];
        totalServerCount: number;
        evalSuiteCount: number;
        recommendedServers: {
          name: string;
          url: string;
          description: string;
          category: string;
        }[];
        members: { _id: string; name: string; imageUrl: string | null; email: string }[];
      }
    | undefined;

  type OrgMetricResult =
    | { value: number; refreshedAt: number | null; windowDays: number }
    | undefined;

  const toolExecutionCount = useQuery(
    "orgMetrics:getOrgMetric" as any,
    organizationId
      ? ({ organizationId, metric: "tool_executions_30d" } as any)
      : "skip"
  ) as OrgMetricResult;

  const messagesSentCount = useQuery(
    "orgMetrics:getOrgMetric" as any,
    organizationId
      ? ({ organizationId, metric: "messages_sent_30d" } as any)
      : "skip"
  ) as OrgMetricResult;

  const fullName =
    convexUser?.name ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    "";
  const firstName = deriveFirstName({
    workosFirst: user?.firstName,
    fullName,
    email: user?.email,
  });
  const greeting = useMemo(() => getGreeting(new Date()), []);

  if (!organizationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <p className="text-lg font-medium">Welcome to MCPJam</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Join or create an organization to see your team&apos;s activity, connected
          servers, and projects in one place.
        </p>
        <Button onClick={() => navigate("/organizations")}>Get started</Button>
      </div>
    );
  }

  const isLoading = data === undefined;

  // PostHog/Attio-style chat takeover: when a session is active OR the user
  // chose "New chat" from inside the takeover, the entire home screen *becomes*
  // the conversation surface. The greeting, stats, and recommended cards drop
  // out until the user clicks Back.
  if (sessionParam || composeParam) {
    return (
      <McpjamAgentTakeoverFrame
        onBack={handleBackToHome}
        onNewChat={handleNewChat}
      >
        {sessionParam ? (
          <McpjamAgentThread
            key={sessionParam}
            sessionId={sessionParam}
            projectId={projectId}
            organizationId={organizationId}
            surface="home"
            variant="full"
            className="flex-1 min-h-0"
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-20 pt-16">
              <McpjamAgentHero
                surface="home"
                onSessionStart={handleSessionStart}
                onResumeSession={handleResumeSession}
                ready={Boolean(projectId)}
              />
            </div>
          </div>
        )}
      </McpjamAgentTakeoverFrame>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8 sm:px-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
            {greeting}, {firstName}
          </h1>
          <OrgStatsStrip
            memberCount={isLoading ? null : data!.memberCount}
            projectCount={isLoading ? null : data!.projects.length}
            totalServerCount={isLoading ? null : data!.totalServerCount}
            evalSuiteCount={isLoading ? null : data!.evalSuiteCount}
            toolExecutionCount={toolExecutionCount?.value ?? null}
            toolExecutionWindowDays={toolExecutionCount?.windowDays ?? 30}
            messagesSentCount={messagesSentCount?.value ?? null}
            messagesSentWindowDays={messagesSentCount?.windowDays ?? 30}
          />
        </header>

        <McpjamAgentHero
          surface="home"
          onSessionStart={handleSessionStart}
          onResumeSession={handleResumeSession}
          ready={Boolean(projectId)}
        />

        <ProductUpdatesRow />

        <div className="grid gap-4 sm:grid-cols-2">
          <RecommendedServers
            servers={data?.recommendedServers}
            projectId={projectId}
          />
          <RecommendedClients projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

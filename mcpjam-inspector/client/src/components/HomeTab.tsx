import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { useAuth } from "@workos-inc/authkit-react";
import { Plus } from "lucide-react";
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

export function HomeTab({ organizationId, projectId }: HomeTabProps) {
  const navigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get("session");

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
          return next;
        },
        { replace: false }
      );
    },
    [setSearchParams]
  );

  const handleNewChat = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("session");
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
  const dateLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

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

  // PostHog/Attio-style chat takeover: when a session is active, the entire
  // home screen *becomes* the conversation — the greeting, stats, and
  // recommended cards drop out until the user starts a new chat.
  if (sessionParam) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center justify-end px-4 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleNewChat}
            className="h-8 gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            <span>New chat</span>
          </Button>
        </div>
        <McpjamAgentThread
          sessionId={sessionParam}
          projectId={projectId}
          organizationId={organizationId}
          surface="home"
          variant="full"
          className="flex-1 min-h-0"
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-8 pb-20 pt-14">
        {/* Greeting */}
        <header className="flex flex-col gap-2">
          <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {dateLabel}
          </p>
          <h1 className="text-[36px] font-semibold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[40px]">
            {greeting},{" "}
            <span className="font-semibold text-muted-foreground">
              {firstName}
            </span>
          </h1>
        </header>

        <McpjamAgentHero
          surface="home"
          onSessionStart={handleSessionStart}
          onResumeSession={handleResumeSession}
          // The backend route requires `projectId`; without it, submit
          // would 400. The hero's own model gate runs inside
          // `useMcpjamAgentSession` on the thread side — the hero itself
          // doesn't see the model, but `projectId` is the gate that
          // matters at mint time.
          ready={Boolean(projectId)}
        />

        {/* Slim stats — pills with dot separators */}
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

        {/* What's new — release feed with hover preview + click-to-expand modal. */}
        <ProductUpdatesRow />

        {/* Hero card */}
        <RecommendedServers
          servers={data?.recommendedServers}
          projectId={projectId}
        />

        {/* Secondary cards */}
        <div className="grid gap-5">
          <RecommendedClients projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bracket,
  Group,
  GroupPrediction,
  ResolvedBracket,
  ResolvedMatch,
  Team,
  TeamId,
  ThirdPlaceSelection,
  WorldCupPrediction,
} from "@shared/types";
import GroupSelector from "./components/GroupSelector";
import ThirdPlaceSelector from "./components/ThirdPlaceSelector";
import BracketView from "./components/BracketView";
import MatchDetailsSheet from "./components/MatchDetailsSheet";
import { resolveBracketLocally } from "./lib/bracket";
import { callTool, getResourceUri, resize, isInMcpHost } from "./lib/mcp-app";
type View = "groups" | "third" | "bracket";

const viewFromUri = (uri?: string): View => {
  if (!uri) return "groups";
  if (uri.includes("third")) return "third";
  if (uri.includes("bracket")) return "bracket";
  return "groups";
};

const dependentMatches = (matchId: string, bracket?: Bracket) => {
  if (!bracket) return [];
  return bracket.matches.filter((m) => {
    const homeSource = m.homeSlot.source;
    const awaySource = m.awaySlot.source;
    const homeDep = homeSource?.type === "winner-of-match" 
      && homeSource.matchId === matchId;
    const awayDep = awaySource?.type === "winner-of-match"
      && awaySource.matchId === matchId;
    return homeDep || awayDep;
  });
};

const pruneDownstreamWinners = (startId: string, bracket: Bracket, winners: Record<string, TeamId | undefined>) => {
  const queue = [startId];
  const visited = new Set<string>();
  const next = { ...winners };

  while (queue.length) {
    const current = queue.shift()!;
    const dependents = dependentMatches(current, bracket);
    dependents.forEach((match) => {
      if (visited.has(match.id)) return;
      visited.add(match.id);
      delete next[match.id];
      queue.push(match.id);
    });
  }

  return next;
};

const WorldCupApp = () => {
  const resourceUri = getResourceUri();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(viewFromUri(resourceUri));

  // Auto-resize when in MCP host
  useEffect(() => {
    if (isInMcpHost()) {
      const resizeObserver = new ResizeObserver(() => {
        resize();
      });
      resizeObserver.observe(document.body);
      resize();
      return () => resizeObserver.disconnect();
    }
  }, []);

  const [teams, setTeams] = useState<Team[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [bracketTemplate, setBracketTemplate] = useState<Bracket | null>(null);
  const [prediction, setPrediction] = useState<WorldCupPrediction | null>(null);
  const [resolvedBracket, setResolvedBracket] = useState<ResolvedBracket | null>(null);
  const [activeMatch, setActiveMatch] = useState<ResolvedMatch | null>(null);
  const [playoffSlots, setPlayoffSlots] = useState<Record<string, string[]>>({});
  const dataReceivedRef = useRef(false);

  useEffect(() => {
    setView(viewFromUri(resourceUri));
  }, [resourceUri]);

  useEffect(() => {
    // Listen for mcp:tool-result event from host (per MCP Apps spec)
    // The host calls the tool and passes the result via this event
    const handleToolResult = (event: Event) => {
      const customEvent = event as CustomEvent;
      const detail = customEvent.detail;
      if (detail && typeof detail === "object") {
        // The tool result is in detail.result or detail directly
        const result = detail.result ?? detail;
        const payload = (result as any)?.data ?? result;
        if (payload?.teams || payload?.groups) {
          dataReceivedRef.current = true;
          setTeams(payload.teams ?? []);
          setGroups(payload.groups ?? []);
          setBracketTemplate(payload.bracketTemplate ?? null);
          setPrediction(payload.prediction ?? null);
          setPlayoffSlots(payload.playoffSlots ?? {});
          setLoading(false);
        }
      }
    };

    // Also listen for postMessage (fallback for different host implementations)
    const handlePostMessage = (event: MessageEvent) => {
      const data = event.data;
      // Handle JSON-RPC response format
      if (data?.jsonrpc === "2.0" && data?.result) {
        const payload = data.result?.data ?? data.result;
        if (payload?.teams || payload?.groups) {
          dataReceivedRef.current = true;
          setTeams(payload.teams ?? []);
          setGroups(payload.groups ?? []);
          setBracketTemplate(payload.bracketTemplate ?? null);
          setPrediction(payload.prediction ?? null);
          setPlayoffSlots(payload.playoffSlots ?? {});
          setLoading(false);
        }
      }
    };

    window.addEventListener("mcp:tool-result", handleToolResult as EventListener);
    window.addEventListener("message", handlePostMessage as EventListener);

    if (isInMcpHost()) {
      // Call the private tool that doesn't have ui/resourceUri metadata
      // This won't trigger MCP Jam to reload the UI
      fetchInitialData();
    } else {
      // Local development mode - fetch directly
      fetchInitialData();
    }

    return () => {
      window.removeEventListener("mcp:tool-result", handleToolResult as EventListener);
      window.removeEventListener("message", handlePostMessage as EventListener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchInitialData = async () => {
    try {
      // Use the private tool that doesn't have ui/resourceUri metadata
      // This prevents MCP Jam from reloading the UI on every call
      const response = await callTool<{
        data?: {
          teams: Team[];
          groups: Group[];
          bracketTemplate: Bracket;
          prediction: WorldCupPrediction;
          playoffSlots?: Record<string, string[]>;
        };
        teams?: Team[];
        groups?: Group[];
        bracketTemplate?: Bracket;
        prediction?: WorldCupPrediction;
        playoffSlots?: Record<string, string[]>;
      }>("worldcup.getDataForWidget", {});
      
      // Handle different response shapes
      const payload = response?.data ?? response;
      
      if (!payload) {
        throw new Error("Empty response from worldcup.getInitialData");
      }
      
      setTeams(payload.teams ?? []);
      setGroups(payload.groups ?? []);
      setBracketTemplate(payload.bracketTemplate ?? null);
      setPrediction(payload.prediction ?? null);
      setPlayoffSlots(payload.playoffSlots ?? {});
      if (payload.prediction && payload.bracketTemplate) {
        setResolvedBracket(resolveBracketLocally(payload.bracketTemplate, payload.prediction));
      }
    } catch (err) {
      setError((err as Error)?.message ?? "Failed to load initial data");
    } finally {
      setLoading(false);
    }
  };

  const teamsById = useMemo(
    () =>
      teams.reduce<Record<TeamId, Team>>((acc, t) => {
        acc[t.id] = t;
        return acc;
      }, {}),
    [teams]
  );

  const handleGroupChange = useCallback((nextGroups: GroupPrediction[]) => {
    setPrediction((prev) => {
      if (!prev) return prev;
      const next = { ...prev, groups: nextGroups };
      if (bracketTemplate) {
        setResolvedBracket(resolveBracketLocally(bracketTemplate, next));
      }
      return next;
    });
  }, [bracketTemplate]);

  const handleThirdChange = useCallback((third: ThirdPlaceSelection) => {
    setPrediction((prev) => {
      if (!prev) return prev;
      const next = { ...prev, thirdPlaceSelection: third };
      if (bracketTemplate) {
        setResolvedBracket(resolveBracketLocally(bracketTemplate, next));
      }
      return next;
    });
  }, [bracketTemplate]);

  const handleWinnerChange = useCallback((matchId: string, teamId: TeamId) => {
    setPrediction((prev) => {
      if (!prev) return prev;
      
      // Prune downstream winners when changing an upstream pick
      const cleanedWinners = bracketTemplate
        ? pruneDownstreamWinners(matchId, bracketTemplate, prev.knockout.winnersByMatchId)
        : { ...prev.knockout.winnersByMatchId };
      
      const next: WorldCupPrediction = {
        ...prev,
        knockout: {
          ...prev.knockout,
          winnersByMatchId: { ...cleanedWinners, [matchId]: teamId },
        },
      };
      
      // Re-resolve the bracket with the new prediction
      if (bracketTemplate) {
        setResolvedBracket(resolveBracketLocally(bracketTemplate, next));
      }
      
      return next;
    });
  }, [bracketTemplate]);

  const handleSave = async () => {
    if (!prediction) return;
    try {
      await callTool("worldcup.savePrediction", { prediction });
    } catch (err) {
      setError((err as Error)?.message ?? "Failed to save prediction");
    }
  };

  const goTo = (next: View) => setView(next);

  useEffect(() => {
    if (view !== "bracket" || !prediction || !bracketTemplate) return;
    setResolvedBracket(resolveBracketLocally(bracketTemplate, prediction));
  }, [view, prediction, bracketTemplate]);

  if (error) {
    return (
      <div className="p-6 space-y-3 animate-fade-in">
        <div className="glass-card p-4 space-y-2">
          <div className="text-sm text-red-400 font-medium">Error loading World Cup data</div>
          <div className="text-xs text-muted-foreground">{error}</div>
          <div className="text-xs text-muted-foreground">
            Check browser console for more details. If using MCP Jam, ensure the server is running.
          </div>
        </div>
      </div>
    );
  }

  if (loading || !prediction || !bracketTemplate) {
    return (
      <div className="p-6 flex items-center justify-center min-h-full">
        <div className="glass-card p-6 text-center space-y-3 animate-fade-in">
          <div className="trophy-shimmer text-2xl font-display font-semibold">
            FIFA World Cup 2026
          </div>
          <div className="text-sm text-muted-foreground">
            {loading ? "Loading tournament data…" : "Unable to load data"}
          </div>
          <div className="flex justify-center">
            <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-4 space-y-3 sm:space-y-4 min-h-full animate-fade-in">

      {view === "groups" && (
        <GroupSelector
          groups={groups}
          teamsById={teamsById}
          playoffSlots={playoffSlots}
          value={prediction.groups}
          onChange={handleGroupChange}
          onContinue={() => goTo("third")}
        />
      )}

      {view === "third" && (
        <ThirdPlaceSelector
          groups={prediction.groups}
          teamsById={teamsById}
          selection={prediction.thirdPlaceSelection}
          onChange={handleThirdChange}
          onContinue={() => goTo("bracket")}
          onBack={() => goTo("groups")}
        />
      )}

      {view === "bracket" && resolvedBracket && (
        <>
          <BracketView
            bracket={resolvedBracket}
            teamsById={teamsById}
            prediction={prediction}
            onWinnerChange={handleWinnerChange}
            onOpenMatch={(m) => setActiveMatch(m)}
            onSave={handleSave}
            onBack={() => goTo("third")}
          />
          <MatchDetailsSheet
            open={Boolean(activeMatch)}
            match={activeMatch}
            teamsById={teamsById}
            onOpenChange={(open) => !open && setActiveMatch(null)}
          />
        </>
      )}
    </div>
  );
};

export default WorldCupApp;


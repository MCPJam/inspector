import { useState, useRef, useEffect, useCallback } from "react";
import {
  ChevronFirst,
  ChevronLast,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  X,
  ChevronDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { JsonEditor } from "@/components/ui/json-editor";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import type { PartialHistoryEntry } from "./useToolInputStreaming";

interface StreamingPlaybackBarProps {
  partialHistory: PartialHistoryEntry[];
  replayToPosition: (position: number) => void;
  exitReplay: () => void;
  isReplayActive: boolean;
  toolCallId: string;
}

const SPEED_OPTIONS = ["0.25", "0.5", "1", "2", "4"] as const;

function getPlaybackDelay(
  entries: PartialHistoryEntry[],
  current: number,
  next: number,
  speed: number,
): number {
  const gap =
    entries[next].elapsedFromStart - entries[current].elapsedFromStart;
  const scaled = gap / speed;
  const maxGap = 2000 / speed;
  return Math.max(32, Math.min(scaled, maxGap));
}

function TickMarkRail({
  entries,
  currentPosition,
  onTickClick,
}: {
  entries: PartialHistoryEntry[];
  currentPosition: number;
  onTickClick: (position: number) => void;
}) {
  const totalDuration =
    entries.length > 1 ? entries[entries.length - 1].elapsedFromStart : 1;

  const progressPercent =
    entries.length > 1
      ? (entries[currentPosition].elapsedFromStart / totalDuration) * 100
      : 100;

  return (
    <div className="relative h-4 w-full mx-1">
      {/* Track background */}
      <div className="absolute top-1/2 left-0 right-0 h-0.5 -translate-y-1/2 bg-border/40 rounded-full" />
      {/* Progress fill */}
      <div
        className="absolute top-1/2 left-0 h-0.5 -translate-y-1/2 bg-primary/50 rounded-full transition-all duration-75"
        style={{ width: `${progressPercent}%` }}
      />
      {/* Tick marks */}
      {entries.map((entry, index) => {
        const leftPercent =
          totalDuration > 0
            ? (entry.elapsedFromStart / totalDuration) * 100
            : (index / Math.max(entries.length - 1, 1)) * 100;

        const isCurrent = index === currentPosition;
        const isFinal = !!entry.isFinal;

        return (
          <Tooltip key={index}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onTickClick(index)}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 cursor-pointer"
                style={{ left: `${leftPercent}%` }}
                aria-label={`Step ${index + 1} (+${entry.elapsedFromStart}ms)`}
              >
                <span
                  className={`block rounded-full transition-all ${
                    isCurrent
                      ? "h-3 w-3 bg-primary ring-2 ring-primary/30"
                      : isFinal
                        ? "h-2 w-2 bg-primary/70"
                        : "h-1.5 w-1.5 bg-muted-foreground/40"
                  }`}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[10px]">
              Step {index + 1} (+{entry.elapsedFromStart}ms)
              {isFinal ? " (final)" : ""}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function StreamingPlaybackBar({
  partialHistory,
  replayToPosition,
  exitReplay,
  isReplayActive,
  toolCallId,
}: StreamingPlaybackBarProps) {
  const [currentPosition, setCurrentPosition] = useState(
    partialHistory.length - 1,
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState("1");
  const [jsonPanelOpen, setJsonPanelOpen] = useState(false);
  const playTimerRef = useRef<number | null>(null);
  const setStreamingPlaybackActive = useWidgetDebugStore(
    (s) => s.setStreamingPlaybackActive,
  );

  const lastIndex = partialHistory.length - 1;

  const stopPlayback = useCallback(() => {
    if (playTimerRef.current !== null) {
      window.clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  const goToPosition = useCallback(
    (position: number) => {
      const clamped = Math.max(0, Math.min(position, lastIndex));
      setCurrentPosition(clamped);
      replayToPosition(clamped);
    },
    [lastIndex, replayToPosition],
  );

  // Auto-play effect
  useEffect(() => {
    if (!isPlaying) return;
    if (currentPosition >= lastIndex) {
      setIsPlaying(false);
      return;
    }

    const speed = parseFloat(playbackSpeed);
    const delay = getPlaybackDelay(
      partialHistory,
      currentPosition,
      currentPosition + 1,
      speed,
    );

    playTimerRef.current = window.setTimeout(() => {
      playTimerRef.current = null;
      const nextPos = currentPosition + 1;
      setCurrentPosition(nextPos);
      replayToPosition(nextPos);
    }, delay);

    return () => {
      if (playTimerRef.current !== null) {
        window.clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, currentPosition, lastIndex, playbackSpeed, partialHistory, replayToPosition]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (playTimerRef.current !== null) {
        window.clearTimeout(playTimerRef.current);
      }
    };
  }, []);

  const handleClose = () => {
    stopPlayback();
    exitReplay();
    setStreamingPlaybackActive(toolCallId, false);
  };

  const handlePlayPause = () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      // If at the end, restart from beginning
      if (currentPosition >= lastIndex) {
        setCurrentPosition(0);
        replayToPosition(0);
      }
      setIsPlaying(true);
    }
  };

  const currentEntry = partialHistory[currentPosition];
  const elapsedMs = currentEntry?.elapsedFromStart ?? 0;

  return (
    <div className="rounded-md border border-border/40 bg-muted/20 p-2 space-y-2">
      {/* Transport controls row */}
      <div className="flex items-center gap-1.5">
        {/* Navigation buttons */}
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="First"
                disabled={currentPosition === 0}
                onClick={() => {
                  stopPlayback();
                  goToPosition(0);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <ChevronFirst className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>First</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Previous"
                disabled={currentPosition === 0}
                onClick={() => {
                  stopPlayback();
                  goToPosition(currentPosition - 1);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <SkipBack className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Previous</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={isPlaying ? "Pause" : "Play"}
                onClick={handlePlayPause}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors cursor-pointer"
              >
                {isPlaying ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{isPlaying ? "Pause" : "Play"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Next"
                disabled={currentPosition >= lastIndex}
                onClick={() => {
                  stopPlayback();
                  goToPosition(currentPosition + 1);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <SkipForward className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Next</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Last"
                disabled={currentPosition >= lastIndex}
                onClick={() => {
                  stopPlayback();
                  goToPosition(lastIndex);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <ChevronLast className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Last</TooltipContent>
          </Tooltip>
        </div>

        {/* Separator */}
        <div className="h-4 w-px bg-border/40" />

        {/* Position label */}
        <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap min-w-[80px]">
          {currentPosition + 1}/{partialHistory.length}{" "}
          <span className="text-muted-foreground/50">+{elapsedMs}ms</span>
        </span>

        {/* Timeline rail */}
        <TickMarkRail
          entries={partialHistory}
          currentPosition={currentPosition}
          onTickClick={(pos) => {
            stopPlayback();
            goToPosition(pos);
          }}
        />

        {/* Speed selector */}
        <Select value={playbackSpeed} onValueChange={setPlaybackSpeed}>
          <SelectTrigger
            size="sm"
            className="h-6 w-[60px] text-[10px] px-1.5 border-border/40"
            aria-label="Playback speed"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEED_OPTIONS.map((speed) => (
              <SelectItem key={speed} value={speed} className="text-[11px]">
                {speed}x
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Close button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Close playback"
              onClick={handleClose}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close playback</TooltipContent>
        </Tooltip>
      </div>

      {/* Collapsible JSON panel */}
      <Collapsible open={jsonPanelOpen} onOpenChange={setJsonPanelOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors cursor-pointer">
          <ChevronDown
            className={`h-3 w-3 transition-transform duration-150 ${
              jsonPanelOpen ? "rotate-0" : "-rotate-90"
            }`}
          />
          Raw JSON
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 rounded-md border border-border/30 bg-muted/20 max-h-[200px] overflow-auto">
            <JsonEditor
              height="100%"
              viewOnly
              value={currentEntry?.input ?? {}}
              className="p-2 text-[11px]"
              collapsible
              defaultExpandDepth={2}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

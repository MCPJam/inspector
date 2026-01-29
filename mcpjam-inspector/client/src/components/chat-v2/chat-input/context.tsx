"use client";

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { LanguageModelUsage } from "ai";
import { type ComponentProps, createContext, useContext } from "react";
import { getUsage } from "tokenlens";
import { getModelById } from "@/shared/types";
import { Loader2 } from "lucide-react";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

type ModelId = string;

type ContextSchema = {
  usedTokens: number;
  maxTokens?: number;
  usage?: LanguageModelUsage;
  modelId: ModelId;
  selectedServers?: string[];
  mcpToolsTokenCount?: Record<string, number> | null;
  mcpToolsTokenCountLoading?: boolean;
  connectedOrConnectingServerConfigs?: Record<string, { name: string }>;
  systemPromptTokenCount?: number | null;
  systemPromptTokenCountLoading?: boolean;
};

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error("Context components must be used within Context");
  }

  return context;
};

export type ContextProps = ComponentProps<typeof HoverCard> & {
  usedTokens: number;
  usage?: LanguageModelUsage;
  modelId: ModelId;
  selectedServers?: string[];
  mcpToolsTokenCount?: Record<string, number> | null;
  mcpToolsTokenCountLoading?: boolean;
  connectedOrConnectingServerConfigs?: Record<string, { name: string }>;
  systemPromptTokenCount?: number | null;
  systemPromptTokenCountLoading?: boolean;
  hasMessages?: boolean;
};

export const Context = ({
  usedTokens,
  usage,
  modelId,
  selectedServers,
  mcpToolsTokenCount,
  mcpToolsTokenCountLoading = false,
  connectedOrConnectingServerConfigs,
  systemPromptTokenCount,
  systemPromptTokenCountLoading = false,
  ...props
}: ContextProps) => {
  const model = getModelById(modelId);
  const maxTokens = model?.contextLength;

  return (
    <ContextContext.Provider
      value={{
        usedTokens,
        maxTokens,
        usage,
        modelId,
        selectedServers,
        mcpToolsTokenCount,
        mcpToolsTokenCountLoading,
        connectedOrConnectingServerConfigs,
        systemPromptTokenCount,
        systemPromptTokenCountLoading,
      }}
    >
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextContext.Provider>
  );
};

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const hasMaxTokens = maxTokens !== undefined;
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = hasMaxTokens ? usedTokens / maxTokens : undefined;
  const dashOffset =
    hasMaxTokens && usedPercent !== undefined
      ? circumference * (1 - usedPercent)
      : undefined;

  return (
    <svg
      aria-label="Model context usage"
      height="20"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      {hasMaxTokens && dashOffset !== undefined && (
        <circle
          cx={ICON_CENTER}
          cy={ICON_CENTER}
          fill="none"
          opacity="0.7"
          r={ICON_RADIUS}
          stroke="currentColor"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          strokeWidth={ICON_STROKE_WIDTH}
          style={{ transformOrigin: "center", transform: "rotate(-90deg)" }}
        />
      )}
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const hasMaxTokens = maxTokens !== undefined;
  const usedPercent = hasMaxTokens ? usedTokens / maxTokens : undefined;
  const displayPct =
    hasMaxTokens && usedPercent !== undefined
      ? new Intl.NumberFormat("en-US", {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(usedPercent)
      : undefined;

  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          {displayPct && (
            <span className="text-xs text-muted-foreground mr-1.5">
              {displayPct}
            </span>
          )}
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({
  className,
  ...props
}: ContextContentProps) => (
  <HoverCardContent
    className={cn("min-w-60 divide-y overflow-hidden p-0", className)}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  if (!maxTokens) return null;
  const usedPercent = usedTokens / maxTokens;
  const displayPct = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(usedPercent);
  const used = new Intl.NumberFormat("en-US", {
    notation: "compact",
  }).format(usedTokens);
  const total = new Intl.NumberFormat("en-US", {
    notation: "compact",
  }).format(maxTokens);

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <p>{displayPct}</p>
            <p className="font-mono text-muted-foreground">
              {used} / {total}
            </p>
          </div>
          <div className="space-y-2">
            <Progress className="bg-muted" value={usedPercent * PERCENT_MAX} />
          </div>
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({
  children,
  className,
  ...props
}: ContextContentBodyProps) => (
  <div className={cn("w-full p-3", className)} {...props}>
    {children}
  </div>
);

export type ContextInputUsageProps = ComponentProps<"div">;

export const ContextInputUsage = ({
  className,
  children,
  ...props
}: ContextInputUsageProps) => {
  const { usage, modelId } = useContextValue();
  const inputTokens = usage?.inputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!inputTokens) {
    return null;
  }

  const inputUsage = modelId
    ? getUsage({
        modelId,
        usage: { input: inputTokens, output: 0 },
      })
    : undefined;
  const inputCost =
    inputUsage?.costUSD?.inputUSD ?? inputUsage?.costUSD?.totalUSD;

  return (
    <div
      className={cn("flex items-center justify-between text-xs", className)}
      {...props}
    >
      <span className="text-muted-foreground">Input</span>
      <TokensWithCost costUSD={inputCost} tokens={inputTokens} />
    </div>
  );
};

export type ContextOutputUsageProps = ComponentProps<"div">;

export const ContextOutputUsage = ({
  className,
  children,
  ...props
}: ContextOutputUsageProps) => {
  const { usage, modelId } = useContextValue();
  const outputTokens = usage?.outputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!outputTokens) {
    return null;
  }

  const outputUsage = modelId
    ? getUsage({
        modelId,
        usage: { input: 0, output: outputTokens },
      })
    : undefined;
  const outputCost =
    outputUsage?.costUSD?.outputUSD ?? outputUsage?.costUSD?.totalUSD;

  return (
    <div
      className={cn("flex items-center justify-between text-xs", className)}
      {...props}
    >
      <span className="text-muted-foreground">Output</span>
      <TokensWithCost costUSD={outputCost} tokens={outputTokens} />
    </div>
  );
};

export type ContextMCPServerUsageProps = ComponentProps<"div">;

export const ContextMCPServerUsage = ({
  className,
  children,
  ...props
}: ContextMCPServerUsageProps) => {
  const {
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    selectedServers,
    connectedOrConnectingServerConfigs,
    usage,
  } = useContextValue();

  if (children) {
    return children;
  }

  // Don't show if no servers selected
  if (!selectedServers || selectedServers.length === 0) {
    return null;
  }

  if (mcpToolsTokenCountLoading) {
    const { systemPromptTokenCount } = useContextValue();
    const hasInputOrOutput =
      (usage?.inputTokens ?? 0) > 0 || (usage?.outputTokens ?? 0) > 0;
    const hasSystemPrompt = (systemPromptTokenCount ?? 0) > 0;
    return (
      <>
        {(hasInputOrOutput || hasSystemPrompt) && (
          <Separator className="my-2" />
        )}
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">MCP Tools</div>
          <div
            className={cn(
              "flex items-center justify-between text-xs",
              className,
            )}
            {...props}
          >
            <span className="text-muted-foreground">Counting tokens...</span>
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          </div>
        </div>
      </>
    );
  }

  if (!mcpToolsTokenCount || Object.keys(mcpToolsTokenCount).length === 0) {
    return null;
  }

  const serversWithTokens = selectedServers
    .filter((serverId) => (mcpToolsTokenCount[serverId] ?? 0) > 0)
    .map((serverId) => ({
      serverId,
      name: connectedOrConnectingServerConfigs?.[serverId]?.name || serverId,
      tokenCount: mcpToolsTokenCount[serverId] ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (serversWithTokens.length === 0) {
    return null;
  }

  const { systemPromptTokenCount } = useContextValue();
  const hasInputOrOutput =
    (usage?.inputTokens ?? 0) > 0 || (usage?.outputTokens ?? 0) > 0;
  const hasSystemPrompt = (systemPromptTokenCount ?? 0) > 0;

  return (
    <>
      {(hasInputOrOutput || hasSystemPrompt) && <Separator className="my-2" />}
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">MCP Tools</div>
        {serversWithTokens.map(({ serverId, name, tokenCount }) => (
          <div
            key={serverId}
            className={cn(
              "flex items-center justify-between text-xs",
              className,
            )}
            {...props}
          >
            <span className="text-muted-foreground">{name}</span>
            <TokensWithCost tokens={tokenCount} />
          </div>
        ))}
      </div>
    </>
  );
};

export type ContextSystemPromptUsageProps = ComponentProps<"div">;

export const ContextSystemPromptUsage = ({
  className,
  children,
  ...props
}: ContextSystemPromptUsageProps) => {
  const { systemPromptTokenCount, systemPromptTokenCountLoading } =
    useContextValue();

  if (children) {
    return children;
  }

  if (systemPromptTokenCountLoading) {
    return (
      <>
        <div className="flex justify-between">
          <div className="text-xs text-muted-foreground">System Prompt</div>
          <div
            className={cn(
              "flex items-center justify-end gap-2 text-xs",
              className,
            )}
            {...props}
          >
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          </div>
        </div>
      </>
    );
  }

  // Don't show if no system prompt tokens
  if (!systemPromptTokenCount || systemPromptTokenCount === 0) {
    return null;
  }

  return (
    <>
      <div className="flex justify-between">
        <div className="text-xs text-muted-foreground">System Prompt</div>
        <div
          className={cn("flex items-center justify-end text-xs", className)}
          {...props}
        >
          <TokensWithCost tokens={systemPromptTokenCount} />
        </div>
      </div>
    </>
  );
};

export type ContextContentFooterProps = ComponentProps<"div">;

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { usage, modelId } = useContextValue();
  const totalCost = modelId
    ? getUsage({
        modelId,
        usage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
        },
      }).costUSD?.totalUSD
    : undefined;

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">Estimated cost</span>
          <span>{formatCurrency(totalCost)}</span>
        </>
      )}
    </div>
  );
};

const TokensWithCost = ({
  tokens,
  costUSD,
}: {
  tokens?: number;
  costUSD?: number;
}) => (
  <span>
    {tokens === undefined
      ? "—"
      : new Intl.NumberFormat("en-US", {
          notation: "compact",
        }).format(tokens)}
    {costUSD ? (
      <span className="ml-2 text-muted-foreground">
        • {formatCurrency(costUSD)}
      </span>
    ) : null}
  </span>
);

const formatCurrency = (value?: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value ?? 0);

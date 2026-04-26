import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import {
  useApp,
  useDocumentTheme,
  useHostStyles,
} from "@modelcontextprotocol/ext-apps/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { Card } from "@mcpjam/design-system/card";
import { cn } from "@mcpjam/design-system/cn";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BookOpen, Check, Copy, Hammer, MessageSquareCode } from "lucide-react";
import {
  StrictMode,
  type ComponentType,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  ServerEntry,
  ServerPrimitiveCollection,
  ServerPrimitiveListStatus,
  ServerPromptInfo,
  ServerResourceInfo,
  ServerStatus,
  ServerToolInfo,
  ShowServersPayload,
} from "../shared/show-servers.js";
import "./global.css";

const APP_INFO = {
  name: "MCPJam servers",
  version: "1.0.0",
};

const STATUS_LABELS: Record<ServerStatus, string> = {
  reachable: "Reachable",
  unreachable: "Unreachable",
  skipped: "Skipped",
  error: "Error",
};

const STATUS_DOT_CLASSES: Record<ServerStatus, string> = {
  reachable: "bg-emerald-500",
  unreachable: "bg-red-500",
  skipped: "bg-muted-foreground/55",
  error: "bg-amber-500",
};

const PRIMITIVE_STATUS_LABELS: Record<ServerPrimitiveListStatus, string> = {
  loaded: "Loaded",
  skipped: "Skipped",
  error: "Error",
};

type HostShellStyle = CSSProperties & Record<`--${string}`, string | number>;

function ShowServersApp() {
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<
    McpUiHostContext | undefined
  >();
  const { app, error } = useApp({
    appInfo: APP_INFO,
    capabilities: {},
    onAppCreated(createdApp) {
      createdApp.ontoolresult = async (result) => {
        setToolResult(result);
      };
      createdApp.onhostcontextchanged = (params) => {
        setHostContext((previous) => mergeHostContext(previous, params));
      };
      createdApp.onerror = (appError) => {
        console.error(appError);
      };
    },
  });
  useHostStyles(app, app?.getHostContext());
  const documentTheme = useDocumentTheme();

  useEffect(() => {
    if (!app) {
      return;
    }

    setHostContext(app.getHostContext());
  }, [app]);

  const isDark = documentTheme === "dark";
  const themePreset = getThemePreset(hostContext);

  if (error) {
    return (
      <Shell
        hostContext={hostContext}
        isDark={isDark}
        themePreset={themePreset}
      >
        <MessageBox
          label="App error"
          message={error.message}
          variant="destructive"
        />
      </Shell>
    );
  }

  if (!app) {
    return (
      <Shell
        hostContext={hostContext}
        isDark={isDark}
        themePreset={themePreset}
      >
        <MessageBox
          label="Connecting"
          message="Waiting for server inventory."
        />
      </Shell>
    );
  }

  return (
    <Shell hostContext={hostContext} isDark={isDark} themePreset={themePreset}>
      <ShowServersContent toolResult={toolResult} />
    </Shell>
  );
}

function Shell({
  children,
  hostContext,
  isDark,
  themePreset,
}: {
  children: ReactNode;
  hostContext?: McpUiHostContext;
  isDark: boolean;
  themePreset: string;
}) {
  const style = {
    ...getHostStyleVariables(hostContext),
    paddingTop: (hostContext?.safeAreaInsets?.top ?? 0) + 16,
    paddingRight: (hostContext?.safeAreaInsets?.right ?? 0) + 16,
    paddingBottom: (hostContext?.safeAreaInsets?.bottom ?? 0) + 16,
    paddingLeft: (hostContext?.safeAreaInsets?.left ?? 0) + 16,
    colorScheme: isDark ? "dark" : "light",
  } satisfies HostShellStyle;

  return (
    <main
      className={cn(
        "app-theme-scope chatbox-host-shell min-h-full bg-background text-foreground font-sans",
        isDark && "dark"
      )}
      data-theme-preset={themePreset}
      style={style}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        {children}
      </div>
    </main>
  );
}

function ShowServersContent({
  toolResult,
}: {
  toolResult: CallToolResult | null;
}) {
  if (!toolResult) {
    return (
      <MessageBox
        label="Loading servers"
        message="Collecting workspace status."
      />
    );
  }

  if (toolResult.isError) {
    return (
      <MessageBox
        label="Unable to load servers"
        message={
          getResultText(toolResult) ??
          "The show_servers tool returned an error."
        }
        variant="destructive"
      />
    );
  }

  const payload = toolResult.structuredContent as
    | ShowServersPayload
    | undefined;
  if (!isShowServersPayload(payload)) {
    return (
      <MessageBox
        label="Missing structured content"
        message="The show_servers tool did not include structured content."
        variant="destructive"
      />
    );
  }

  return <ServerInventory payload={payload} />;
}

function ServerInventory({ payload }: { payload: ShowServersPayload }) {
  const [selectedServerId, setSelectedServerId] = useState<string | undefined>(
    payload.servers[0]?.id
  );

  useEffect(() => {
    if (payload.servers.some((server) => server.id === selectedServerId)) {
      return;
    }

    setSelectedServerId(payload.servers[0]?.id);
  }, [payload.servers, selectedServerId]);

  const selectedServer =
    payload.servers.find((server) => server.id === selectedServerId) ??
    payload.servers[0];

  return (
    <>
      <header className="flex items-center justify-between gap-4 pb-1">
        <div className="min-w-0 flex flex-wrap items-center gap-2">
          <h1 className="break-words text-xl font-semibold leading-tight sm:text-2xl">
            {payload.workspace.name}
          </h1>
          <Badge variant="secondary" className="shrink-0">
            {formatServerCount(payload.servers.length)}
          </Badge>
        </div>
        <McpJamLogo className="h-9 w-9 shrink-0" />
      </header>

      {payload.servers.length > 0 ? (
        <section className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="grid content-start gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {payload.servers.map((server) => (
              <ServerConnectionCard
                key={server.id}
                server={server}
                selected={server.id === selectedServer?.id}
                onSelect={() => setSelectedServerId(server.id)}
              />
            ))}
          </div>
          {selectedServer ? (
            <ServerDetailPanel server={selectedServer} />
          ) : null}
        </section>
      ) : (
        <MessageBox
          label="No servers"
          message="This workspace has no MCP servers."
        />
      )}
    </>
  );
}

function ServerConnectionCard({
  server,
  selected,
  onSelect,
}: {
  server: ServerEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const displayUrl = server.url ?? getMissingUrlLabel(server);
  const version = server.serverInfo?.version;

  const copyUrl = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (!server.url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(server.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <Card
      className={cn(
        "group relative h-full rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm transition-colors duration-200 hover:border-border",
        selected && "border-primary/60 bg-accent/50"
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="block h-full w-full cursor-pointer rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {server.name}
              </h2>
              {version ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  v{version}
                </span>
              ) : null}
            </div>
          </div>

          <span className="inline-flex shrink-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            <StatusDot status={server.status} />
            {STATUS_LABELS[server.status]}
          </span>
        </div>

        <div className="relative mt-4 rounded-md border border-border/50 bg-muted/30 p-2 pr-8 font-mono text-xs text-muted-foreground">
          <div className="break-all">{displayUrl}</div>
        </div>
      </button>
      {server.url ? (
        <button
          aria-label={`Copy URL for ${server.name}`}
          title={`Copy URL for ${server.name}`}
          type="button"
          onClick={copyUrl}
          className="absolute bottom-5 right-5 cursor-pointer p-1 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </Card>
  );
}

function ServerDetailPanel({ server }: { server: ServerEntry }) {
  const primitives = server.primitives;

  return (
    <Card className="min-h-[24rem] rounded-xl border border-border/50 bg-card/70 p-0 shadow-sm">
      <div className="border-b border-border/60 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold text-foreground">
              {server.name}
            </h2>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {server.url ?? getMissingUrlLabel(server)}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
            <StatusDot status={server.status} />
            {STATUS_LABELS[server.status]}
          </span>
        </div>
        {server.statusDetail ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {server.statusDetail}
          </p>
        ) : null}
      </div>

      {primitives ? (
        <div className="grid gap-5 p-4 xl:grid-cols-3">
          <PrimitiveGroup
            label="Tools"
            icon={Hammer}
            collection={primitives.tools}
            emptyLabel="No tools discovered."
            getKey={(tool) => tool.name}
            renderItem={(tool) => <ToolPrimitiveItem tool={tool} />}
          />
          <PrimitiveGroup
            label="Resources"
            icon={BookOpen}
            collection={primitives.resources}
            emptyLabel="No resources discovered."
            getKey={(resource) => resource.uri}
            renderItem={(resource) => (
              <ResourcePrimitiveItem resource={resource} />
            )}
          />
          <PrimitiveGroup
            label="Prompts"
            icon={MessageSquareCode}
            collection={primitives.prompts}
            emptyLabel="No prompts discovered."
            getKey={(prompt) => prompt.name}
            renderItem={(prompt) => <PromptPrimitiveItem prompt={prompt} />}
          />
        </div>
      ) : (
        <div className="p-4">
          <MessageBox
            label="Primitives unavailable"
            message={
              server.statusDetail ??
              "Tools, resources, and prompts were not collected for this server."
            }
          />
        </div>
      )}
    </Card>
  );
}

function PrimitiveGroup<TItem>({
  label,
  icon: Icon,
  collection,
  emptyLabel,
  getKey,
  renderItem,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  collection: ServerPrimitiveCollection<TItem>;
  emptyLabel: string;
  getKey: (item: TItem) => string;
  renderItem: (item: TItem) => ReactNode;
}) {
  const hasItems = collection.items.length > 0;

  return (
    <section className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h3 className="truncate text-sm font-semibold">{label}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="secondary">{collection.items.length}</Badge>
          {collection.status !== "loaded" ? (
            <Badge variant="outline">
              {PRIMITIVE_STATUS_LABELS[collection.status]}
            </Badge>
          ) : null}
        </div>
      </div>

      {collection.statusDetail ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {collection.statusDetail}
        </p>
      ) : null}

      {hasItems ? (
        <ul className="mt-3 max-h-80 overflow-auto pr-1">
          {collection.items.map((item) => (
            <li
              key={getKey(item)}
              className="border-t border-border/50 py-3 first:border-t-0"
            >
              {renderItem(item)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </section>
  );
}

function ToolPrimitiveItem({ tool }: { tool: ServerToolInfo }) {
  return (
    <div className="min-w-0">
      <div className="break-words font-mono text-xs font-medium text-foreground">
        {tool.name}
      </div>
      {tool.title ? (
        <div className="mt-1 break-words text-sm text-foreground">
          {tool.title}
        </div>
      ) : null}
      {tool.description ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {tool.description}
        </p>
      ) : null}
    </div>
  );
}

function ResourcePrimitiveItem({ resource }: { resource: ServerResourceInfo }) {
  const title = resource.title ?? resource.name;

  return (
    <div className="min-w-0">
      {title ? (
        <div className="break-words text-sm font-medium text-foreground">
          {title}
        </div>
      ) : null}
      <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
        {resource.uri}
      </div>
      {resource.mimeType ? (
        <div className="mt-1 text-xs text-muted-foreground">
          {resource.mimeType}
        </div>
      ) : null}
      {resource.description ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {resource.description}
        </p>
      ) : null}
    </div>
  );
}

function PromptPrimitiveItem({ prompt }: { prompt: ServerPromptInfo }) {
  return (
    <div className="min-w-0">
      <div className="break-words font-mono text-xs font-medium text-foreground">
        {prompt.name}
      </div>
      {prompt.title ? (
        <div className="mt-1 break-words text-sm text-foreground">
          {prompt.title}
        </div>
      ) : null}
      {prompt.description ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {prompt.description}
        </p>
      ) : null}
      {prompt.arguments && prompt.arguments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {prompt.arguments.map((argument) => (
            <span
              key={argument.name}
              className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              title={argument.description}
            >
              {argument.name}
              {argument.required ? "*" : ""}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusDot({ status }: { status: ServerStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        STATUS_DOT_CLASSES[status]
      )}
    />
  );
}

function MessageBox({
  label,
  message,
  variant = "default",
}: {
  label: string;
  message: string;
  variant?: "default" | "destructive";
}) {
  return (
    <Alert variant={variant} className="border-border/50 bg-card shadow-sm">
      <AlertTitle>{label}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function McpJamLogo({ className }: { className?: string }) {
  return (
    <svg
      aria-label="MCPJam"
      className={className}
      role="img"
      viewBox="0 0 1080 1080"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="1080" height="1080" rx="241" fill="#2D2D2D" />
      <path
        d="M196.547 508V298H245.447L332.447 440.8H306.647L391.247 298H440.147L440.747 508H386.147L385.547 381.1H394.847L331.547 487.3H305.147L240.047 381.1H251.447V508H196.547ZM587.477 512.2C570.877 512.2 555.477 509.6 541.277 504.4C527.277 499 515.077 491.4 504.677 481.6C494.477 471.8 486.477 460.3 480.677 447.1C474.877 433.7 471.977 419 471.977 403C471.977 387 474.877 372.4 480.677 359.2C486.477 345.8 494.477 334.2 504.677 324.4C515.077 314.6 527.277 307.1 541.277 301.9C555.477 296.5 570.877 293.8 587.477 293.8C606.877 293.8 624.177 297.2 639.377 304C654.777 310.8 667.577 320.6 677.777 333.4L639.977 367.6C633.177 359.6 625.677 353.5 617.477 349.3C609.477 345.1 600.477 343 590.477 343C581.877 343 573.977 344.4 566.777 347.2C559.577 350 553.377 354.1 548.177 359.5C543.177 364.7 539.177 371 536.177 378.4C533.377 385.8 531.977 394 531.977 403C531.977 412 533.377 420.2 536.177 427.6C539.177 435 543.177 441.4 548.177 446.8C553.377 452 559.577 456 566.777 458.8C573.977 461.6 581.877 463 590.477 463C600.477 463 609.477 460.9 617.477 456.7C625.677 452.5 633.177 446.4 639.977 438.4L677.777 472.6C667.577 485.2 654.777 495 639.377 502C624.177 508.8 606.877 512.2 587.477 512.2ZM704.262 508V298H800.262C819.462 298 835.962 301.1 849.762 307.3C863.762 313.5 874.562 322.5 882.162 334.3C889.762 345.9 893.562 359.7 893.562 375.7C893.562 391.5 889.762 405.2 882.162 416.8C874.562 428.4 863.762 437.4 849.762 443.8C835.962 450 819.462 453.1 800.262 453.1H737.262L763.662 427.3V508H704.262ZM763.662 433.6L737.262 406.3H796.662C809.062 406.3 818.262 403.6 824.262 398.2C830.462 392.8 833.562 385.3 833.562 375.7C833.562 365.9 830.462 358.3 824.262 352.9C818.262 347.5 809.062 344.8 796.662 344.8H737.262L763.662 317.5V433.6Z"
        fill="#FBFBFB"
      />
      <path
        d="M264.566 792.2C249.166 792.2 235.166 789.6 222.566 784.4C210.166 779 199.866 771.3 191.666 761.3L224.066 722.9C229.666 730.1 235.466 735.6 241.466 739.4C247.466 743 253.766 744.8 260.366 744.8C277.966 744.8 286.766 734.6 286.766 714.2V623.9H214.166V578H345.566V710.6C345.566 738 338.666 758.5 324.866 772.1C311.066 785.5 290.966 792.2 264.566 792.2ZM356.064 788L448.764 578H507.264L600.264 788H538.464L465.864 607.1H489.264L416.664 788H356.064ZM406.764 747.2L422.064 703.4H524.664L539.964 747.2H406.764ZM617.104 788V578H666.004L753.004 720.8H727.204L811.804 578H860.704L861.304 788H806.704L806.104 661.1H815.404L752.104 767.3H725.704L660.604 661.1H672.004V788H617.104Z"
        fill="#F2735B"
      />
    </svg>
  );
}

function getResultText(result: CallToolResult): string | undefined {
  const textBlock = result.content?.find((entry) => entry.type === "text");

  return textBlock?.type === "text" ? textBlock.text : undefined;
}

function isShowServersPayload(value: unknown): value is ShowServersPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    "workspace" in value &&
    "servers" in value &&
    Array.isArray((value as ShowServersPayload).servers)
  );
}

function mergeHostContext(
  previous: McpUiHostContext | undefined,
  next: Partial<McpUiHostContext>
): McpUiHostContext {
  const merged = { ...(previous ?? {}), ...next } as McpUiHostContext;

  if (next.styles) {
    const previousStyles = previous?.styles;
    merged.styles = {
      ...previousStyles,
      ...next.styles,
      variables: next.styles.variables
        ? {
            ...previousStyles?.variables,
            ...next.styles.variables,
          }
        : previousStyles?.variables,
      css: next.styles.css
        ? {
            ...previousStyles?.css,
            ...next.styles.css,
          }
        : previousStyles?.css,
    };
  }

  return merged;
}

function getHostStyleVariables(hostContext?: McpUiHostContext): HostShellStyle {
  const variables = hostContext?.styles?.variables as
    | Record<string, unknown>
    | undefined;
  if (!variables) {
    return {};
  }

  const scopedVariables: HostShellStyle = {};
  for (const [key, value] of Object.entries(variables)) {
    if (
      key.startsWith("--") &&
      (typeof value === "string" || typeof value === "number")
    ) {
      scopedVariables[key as `--${string}`] = value;
    }
  }

  mapHostToken(
    scopedVariables,
    variables,
    "--background",
    "--color-background-primary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--foreground",
    "--color-text-primary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--card",
    "--color-background-secondary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--card-foreground",
    "--color-text-primary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--muted",
    "--color-background-tertiary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--muted-foreground",
    "--color-text-secondary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--accent",
    "--color-background-tertiary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--accent-foreground",
    "--color-text-primary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--border",
    "--color-border-primary"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--input",
    "--color-border-secondary"
  );
  mapHostToken(scopedVariables, variables, "--ring", "--color-ring-primary");
  mapHostToken(
    scopedVariables,
    variables,
    "--destructive",
    "--color-background-danger"
  );
  mapHostToken(
    scopedVariables,
    variables,
    "--destructive-foreground",
    "--color-text-danger"
  );
  mapHostToken(scopedVariables, variables, "--success", "--color-text-success");
  mapHostToken(scopedVariables, variables, "--warning", "--color-text-warning");

  return scopedVariables;
}

function mapHostToken(
  target: HostShellStyle,
  source: Record<string, unknown>,
  token: `--${string}`,
  hostToken: `--${string}`
) {
  const value = source[hostToken];
  if (typeof value === "string" || typeof value === "number") {
    target[token] = value;
  }
}

function getThemePreset(hostContext?: McpUiHostContext): string {
  const variables = hostContext?.styles?.variables as
    | Record<string, unknown>
    | undefined;
  const value = variables?.["--mcpjam-theme-preset"];
  return typeof value === "string" && value.length > 0 ? value : "default";
}

function formatServerCount(count: number): string {
  return `${count} ${count === 1 ? "server" : "servers"}`;
}

function getMissingUrlLabel(server: ServerEntry): string {
  return server.transportType === "stdio" ? "STDIO transport" : "No URL";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShowServersApp />
  </StrictMode>
);

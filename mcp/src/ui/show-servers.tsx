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
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Hammer,
  MessageSquareCode,
} from "lucide-react";
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
import mcpJamDarkLogoUrl from "../../../docs/logo/mcp_jam_dark.png?url";
import mcpJamLightLogoUrl from "../../../docs/logo/mcp_jam_light.png?url";
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
  useHostStyles(app, hostContext ?? app?.getHostContext());
  const documentTheme = useDocumentTheme();

  useEffect(() => {
    if (!app) {
      return;
    }

    setHostContext(app.getHostContext());
  }, [app]);

  const activeTheme = hostContext?.theme ?? documentTheme;
  const isDark = activeTheme === "dark";
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
      <ShowServersContent toolResult={toolResult} isDark={isDark} />
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
  isDark,
  toolResult,
}: {
  isDark: boolean;
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

  return <ServerInventory isDark={isDark} payload={payload} />;
}

function ServerInventory({
  isDark,
  payload,
}: {
  isDark: boolean;
  payload: ShowServersPayload;
}) {
  const [selectedServerId, setSelectedServerId] = useState<string | undefined>(
    undefined
  );

  useEffect(() => {
    if (
      selectedServerId === undefined ||
      payload.servers.some((server) => server.id === selectedServerId)
    ) {
      return;
    }

    setSelectedServerId(undefined);
  }, [payload.servers, selectedServerId]);

  const selectedServer = payload.servers.find(
    (server) => server.id === selectedServerId
  );

  if (selectedServer) {
    return (
      <ServerDetailScreen
        server={selectedServer}
        onBack={() => setSelectedServerId(undefined)}
      />
    );
  }

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
        <McpJamLogo isDark={isDark} />
      </header>

      {payload.servers.length > 0 ? (
        <section className="grid gap-3 sm:grid-cols-2">
          {payload.servers.map((server) => (
            <ServerConnectionCard
              key={server.id}
              server={server}
              onSelect={() => setSelectedServerId(server.id)}
            />
          ))}
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
  onSelect,
}: {
  server: ServerEntry;
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
    <Card className="group relative h-full rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm transition-colors duration-200 hover:border-border">
      <button
        type="button"
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

function ServerDetailScreen({
  server,
  onBack,
}: {
  server: ServerEntry;
  onBack: () => void;
}) {
  const primitives = server.primitives;

  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to servers"
            title="Back to servers"
            className="mt-1 inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="break-words text-xl font-semibold leading-tight sm:text-2xl">
                {server.name}
              </h1>
              {server.serverInfo?.version ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  v{server.serverInfo.version}
                </span>
              ) : null}
            </div>
            <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
              {server.url ?? getMissingUrlLabel(server)}
            </div>
            {server.statusDetail ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {server.statusDetail}
              </p>
            ) : null}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
          <StatusDot status={server.status} />
          {STATUS_LABELS[server.status]}
        </span>
      </header>

      {primitives ? (
        <div className="flex flex-col gap-3">
          <PrimitiveDropdown
            label="Tools"
            icon={Hammer}
            collection={primitives.tools}
            emptyLabel="No tools discovered."
            getKey={(tool) => tool.name}
            renderItem={(tool) => <ToolPrimitiveItem tool={tool} />}
          />
          <PrimitiveDropdown
            label="Resources"
            icon={BookOpen}
            collection={primitives.resources}
            emptyLabel="No resources discovered."
            getKey={(resource) => resource.uri}
            renderItem={(resource) => (
              <ResourcePrimitiveItem resource={resource} />
            )}
          />
          <PrimitiveDropdown
            label="Prompts"
            icon={MessageSquareCode}
            collection={primitives.prompts}
            emptyLabel="No prompts discovered."
            getKey={(prompt) => prompt.name}
            renderItem={(prompt) => <PromptPrimitiveItem prompt={prompt} />}
          />
        </div>
      ) : (
        <MessageBox
          label="Primitives unavailable"
          message={
            server.statusDetail ??
            "Tools, resources, and prompts were not collected for this server."
          }
        />
      )}
    </div>
  );
}

function PrimitiveDropdown<TItem>({
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
  const [open, setOpen] = useState(false);
  const hasItems = collection.items.length > 0;

  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{label}</h2>
            {collection.statusDetail ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {collection.statusDetail}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{collection.items.length}</Badge>
          {collection.status !== "loaded" ? (
            <Badge variant="outline">
              {PRIMITIVE_STATUS_LABELS[collection.status]}
            </Badge>
          ) : null}
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </div>
      </button>

      {open ? (
        <div className="border-t border-border/60 px-4 py-2">
          {hasItems ? (
            <ul>
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
            <p className="py-3 text-sm text-muted-foreground">{emptyLabel}</p>
          )}
        </div>
      ) : null}
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

function McpJamLogo({ isDark }: { isDark: boolean }) {
  return (
    <img
      src={isDark ? mcpJamDarkLogoUrl : mcpJamLightLogoUrl}
      alt="MCPJam"
      className="h-5 w-auto shrink-0 object-contain sm:h-6"
    />
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

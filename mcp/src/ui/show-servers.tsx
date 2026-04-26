import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@mcpjam/design-system/card";
import { cn } from "@mcpjam/design-system/cn";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Check, Copy } from "lucide-react";
import {
  StrictMode,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  ServerEntry,
  ServerStatus,
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

type HostShellStyle = CSSProperties & Record<`--${string}`, string | number>;

function ShowServersApp() {
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [prefersDark, setPrefersDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const { app, error } = useApp({
    appInfo: APP_INFO,
    capabilities: {},
    onAppCreated(createdApp) {
      createdApp.ontoolresult = async (result) => {
        setToolResult(result);
      };
      createdApp.onhostcontextchanged = (params) => {
        setHostContext((previous) => ({ ...previous, ...params }));
      };
      createdApp.onerror = (appError) => {
        console.error(appError);
      };
    },
  });

  useEffect(() => {
    if (!app) {
      return;
    }

    setHostContext(app.getHostContext());
  }, [app]);

  useEffect(() => {
    const hostFonts = hostContext?.styles?.css?.fonts;
    if (!hostFonts) {
      return;
    }

    const styleTag = document.createElement("style");
    styleTag.dataset.mcpjamHostFonts = "true";
    styleTag.textContent = hostFonts;
    document.head.appendChild(styleTag);

    return () => {
      styleTag.remove();
    };
  }, [hostContext?.styles?.css?.fonts]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };

    setPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  const isDark =
    hostContext?.theme === "dark" ||
    (hostContext?.theme !== "light" && prefersDark);
  const themePreset = getThemePreset(hostContext);

  if (error) {
    return (
      <Shell hostContext={hostContext} isDark={isDark} themePreset={themePreset}>
        <MessageBox label="App error" message={error.message} variant="destructive" />
      </Shell>
    );
  }

  if (!app) {
    return (
      <Shell hostContext={hostContext} isDark={isDark} themePreset={themePreset}>
        <MessageBox label="Connecting" message="Waiting for server inventory." />
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
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">{children}</div>
    </main>
  );
}

function ShowServersContent({ toolResult }: { toolResult: CallToolResult | null }) {
  if (!toolResult) {
    return <MessageBox label="Loading servers" message="Collecting workspace status." />;
  }

  if (toolResult.isError) {
    return (
      <MessageBox
        label="Unable to load servers"
        message={getResultText(toolResult) ?? "The show_servers tool returned an error."}
        variant="destructive"
      />
    );
  }

  const payload = toolResult.structuredContent as ShowServersPayload | undefined;
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
  const generatedAt = useMemo(() => formatDateValue(payload.generatedAt), [payload.generatedAt]);

  return (
    <>
      <header className="flex flex-col gap-3 border-b border-border/50 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-xl font-semibold leading-tight sm:text-2xl">
              {payload.workspace.name}
            </h1>
            <Badge variant="secondary">{payload.servers.length} servers</Badge>
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {payload.workspace.id}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {Object.entries(payload.summary).map(([status, count]) => (
            <span
              key={status}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1"
            >
              <StatusDot status={status as ServerStatus} />
              {STATUS_LABELS[status as ServerStatus]} {count}
            </span>
          ))}
          {generatedAt ? <span>{generatedAt}</span> : null}
        </div>
      </header>

      {payload.servers.length > 0 ? (
        <section className="grid gap-3 sm:grid-cols-2">
          {payload.servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </section>
      ) : (
        <MessageBox label="No servers" message="This workspace has no MCP servers." />
      )}

      {payload.otherWorkspaces.length > 0 ? (
        <footer className="space-y-2 border-t border-border/50 pt-4">
          <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Other workspaces
          </h2>
          <div className="flex flex-wrap gap-2">
            {payload.otherWorkspaces.map((workspace) => (
              <Badge key={workspace.id} variant="outline" className="max-w-full">
                <span className="truncate">{workspace.name}</span>
              </Badge>
            ))}
          </div>
        </footer>
      ) : null}
    </>
  );
}

function ServerCard({ server }: { server: ServerEntry }) {
  const [copied, setCopied] = useState(false);
  const displayUrl = server.url ?? "No URL";
  const version = server.serverInfo?.version;

  const copyUrl = async () => {
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
    <Card className="h-full rounded-lg border-border/50 bg-card/70 shadow-sm">
      <CardHeader className="space-y-3 p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="break-words text-sm leading-tight">
              {server.name}
            </CardTitle>
            {version ? (
              <p className="font-mono text-xs text-muted-foreground">v{version}</p>
            ) : null}
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
            <StatusDot status={server.status} />
            {STATUS_LABELS[server.status]}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 p-4 pt-2">
        <div className="relative rounded-md border border-border/50 bg-muted/30 p-2 pr-11 font-mono text-xs text-muted-foreground">
          <div className="break-all">{displayUrl}</div>
          {server.url ? (
            <Button
              aria-label={`Copy URL for ${server.name}`}
              title={`Copy URL for ${server.name}`}
              type="button"
              variant="ghost"
              size="sm"
              onClick={copyUrl}
              className="absolute right-1 top-1 h-8 w-8 p-0 text-muted-foreground/70 hover:text-foreground"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
        </div>

        {server.statusDetail ? (
          <p className="break-words text-xs leading-5 text-muted-foreground">
            {server.statusDetail}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusDot({ status }: { status: ServerStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT_CLASSES[status])}
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

function getHostStyleVariables(hostContext?: McpUiHostContext): HostShellStyle {
  const variables = hostContext?.styles?.variables;
  if (!variables) {
    return {};
  }

  const scopedVariables = Object.fromEntries(
    Object.entries(variables).filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return key.startsWith("--") && typeof value === "string" && value.length > 0;
    })
  );

  return scopedVariables as HostShellStyle;
}

function getThemePreset(hostContext?: McpUiHostContext): string {
  const variables = hostContext?.styles?.variables as Record<string, unknown> | undefined;
  const value = variables?.["--mcpjam-theme-preset"];
  return typeof value === "string" && value.length > 0 ? value : "default";
}

function formatDateValue(value: string): string | undefined {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShowServersApp />
  </StrictMode>
);

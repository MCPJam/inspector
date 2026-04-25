import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@mcpjam/design-system/card";
import { Separator } from "@mcpjam/design-system/separator";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WhoamiPayload } from "../shared/whoami.js";
import "./global.css";

const APP_INFO = {
  name: "MCPJam whoami",
  version: "1.0.0",
};

function WhoamiApp() {
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
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
    const hostVariables = hostContext?.styles?.variables;
    if (!hostVariables) {
      return;
    }

    const appliedKeys: string[] = [];
    for (const [key, value] of Object.entries(hostVariables)) {
      if (value == null) {
        continue;
      }
      document.documentElement.style.setProperty(key, value);
      appliedKeys.push(key);
    }

    return () => {
      for (const key of appliedKeys) {
        document.documentElement.style.removeProperty(key);
      }
    };
  }, [hostContext?.styles?.variables]);

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
    const root = document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const isDark =
        hostContext?.theme != null
          ? hostContext.theme === "dark"
          : mediaQuery.matches;
      root.classList.toggle("dark", isDark);
      root.style.colorScheme = isDark ? "dark" : "light";
    };

    applyTheme();

    if (hostContext?.theme != null) {
      return;
    }

    mediaQuery.addEventListener("change", applyTheme);
    return () => {
      mediaQuery.removeEventListener("change", applyTheme);
    };
  }, [hostContext?.theme]);

  if (error) {
    return (
      <Shell hostContext={hostContext}>
        <MessageBox label="App error" message={error.message} variant="destructive" />
      </Shell>
    );
  }

  if (!app) {
    return (
      <Shell hostContext={hostContext}>
        <MessageBox
          label="Connecting"
          message="Waiting for the host to finish initializing the whoami view."
        />
      </Shell>
    );
  }

  return (
    <Shell hostContext={hostContext}>
      <WhoamiContent toolResult={toolResult} hostContext={hostContext} />
    </Shell>
  );
}

function Shell({
  children,
  hostContext,
}: {
  children: ReactNode;
  hostContext?: McpUiHostContext;
}) {
  return (
    <main
      className="min-h-full bg-background"
      style={{
        paddingTop: (hostContext?.safeAreaInsets?.top ?? 0) + 16,
        paddingRight: (hostContext?.safeAreaInsets?.right ?? 0) + 16,
        paddingBottom: (hostContext?.safeAreaInsets?.bottom ?? 0) + 16,
        paddingLeft: (hostContext?.safeAreaInsets?.left ?? 0) + 16,
      }}
    >
      <div className="mx-auto w-full max-w-xl">{children}</div>
    </main>
  );
}

function WhoamiContent({
  toolResult,
  hostContext,
}: {
  toolResult: CallToolResult | null;
  hostContext?: McpUiHostContext;
}) {
  if (!toolResult) {
    return (
      <MessageBox
        label="Loading profile"
        message="The host is preparing the authenticated MCPJam identity payload."
      />
    );
  }

  if (toolResult.isError) {
    return (
      <MessageBox
        label="Unable to load profile"
        message={getResultText(toolResult) ?? "The whoami tool returned an error."}
        variant="destructive"
      />
    );
  }

  const payload = toolResult.structuredContent as WhoamiPayload | undefined;
  if (!payload) {
    return (
      <MessageBox
        label="Missing structured content"
        message="The whoami tool did not include structured content for the UI view."
        variant="destructive"
      />
    );
  }

  const userRecord = asRecord(payload.user);
  const displayName = getStringValue(userRecord, "name") ?? "Authenticated MCPJam user";
  const displayEmail =
    getStringValue(userRecord, "email") ?? "No email field was returned";
  const createdAt = formatCreatedAt(userRecord, hostContext);
  const rawJson = JSON.stringify(payload, null, 2);

  return (
    <Card className="border-border/70 bg-card/95 shadow-lg backdrop-blur">
      <CardHeader className="gap-4 border-b border-border/70 pb-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            <Badge
              variant="secondary"
              className="w-fit uppercase tracking-[0.18em]"
            >
              Authenticated identity
            </Badge>
            <div className="space-y-1.5">
              <CardTitle className="text-2xl leading-tight sm:text-3xl">
                {displayName}
              </CardTitle>
              <CardDescription className="max-w-[34rem] text-sm sm:text-[0.95rem]">
                The same bearer token accepted by the MCP server was forwarded to
                Convex and resolved into the user record below.
              </CardDescription>
            </div>
          </div>
          <Badge
            variant="outline"
            className="w-fit font-mono text-[0.72rem] uppercase tracking-[0.18em]"
          >
            whoami
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        <section className="rounded-lg border bg-muted/35 p-4 sm:p-5">
          <p className="break-all text-base font-semibold sm:text-lg">
            {displayEmail}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Convex resolved this session to the MCPJam user record below.
          </p>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <FactItem label="User ID" value={payload.id} monospace />
            <FactItem label="Created" value={createdAt} />
          </dl>
        </section>

        <Separator />

        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Raw JSON
            </h2>
            <p className="text-sm text-muted-foreground">
              Structured content returned to the widget renderer.
            </p>
          </div>

          <div className="overflow-auto rounded-lg border bg-muted/45 p-4">
            <pre className="m-0 font-mono text-xs leading-6 whitespace-pre-wrap break-all text-foreground">
              <code>{rawJson}</code>
            </pre>
          </div>
        </section>
      </CardContent>
    </Card>
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
    <Alert variant={variant} className="border-border/70 bg-card/95 shadow-sm">
      <AlertTitle>{label}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function FactItem({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/80 p-3">
      <dt className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`mt-2 break-all text-sm font-medium sm:text-[0.95rem] ${
          monospace ? "font-mono" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function getResultText(result: CallToolResult): string | undefined {
  const textBlock = result.content?.find((entry) => entry.type === "text");

  return textBlock?.type === "text" ? textBlock.text : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getStringValue(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumberValue(
  record: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCreatedAt(
  userRecord: Record<string, unknown> | undefined,
  hostContext?: McpUiHostContext
): string {
  const explicitCreatedAt = getStringValue(userRecord, "createdAt");
  if (explicitCreatedAt) {
    const formatted = formatDateValue(explicitCreatedAt, hostContext);
    return formatted ?? explicitCreatedAt;
  }

  const convexCreationTime = getNumberValue(userRecord, "_creationTime");
  if (convexCreationTime != null) {
    const formatted = formatDateValue(convexCreationTime, hostContext);
    return formatted ?? String(convexCreationTime);
  }

  return "Not provided";
}

function formatDateValue(
  value: string | number,
  hostContext?: McpUiHostContext
): string | undefined {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  try {
    return new Intl.DateTimeFormat(hostContext?.locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: hostContext?.timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WhoamiApp />
  </StrictMode>
);

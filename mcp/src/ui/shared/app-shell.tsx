/**
 * Shared MCP Apps shell: the host handshake (`useMcpAppHost`), host-context
 * and theme application, and the chrome (Shell, MessageBox, logo) every
 * MCPJam widget view renders inside. Extracted from the original
 * show-servers app so all views in the single UI bundle share one
 * implementation.
 */
import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
  type McpUiHostContextChangedNotification,
} from "@modelcontextprotocol/ext-apps";
import {
  useApp,
  useDocumentTheme,
} from "@modelcontextprotocol/ext-apps/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { cn } from "@mcpjam/design-system/cn";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import mcpJamDarkLogoUrl from "../../../../docs/logo/mcp_jam_dark.png?url";
import mcpJamLightLogoUrl from "../../../../docs/logo/mcp_jam_light.png?url";

export type HostShellStyle = CSSProperties &
  Record<`--${string}`, string | number>;

export function useMcpAppHost(appInfo: { name: string; version: string }) {
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<
    McpUiHostContext | undefined
  >();
  const { app, error } = useApp({
    appInfo,
    capabilities: {},
    onAppCreated(createdApp) {
      createdApp.ontoolresult = async (result) => {
        setToolResult(result);
      };
      createdApp.onerror = (appError) => {
        console.error(appError);
      };
    },
  });
  const documentTheme = useDocumentTheme();

  useEffect(() => {
    if (!app) {
      return;
    }

    const initialHostContext = app.getHostContext();
    setHostContext(initialHostContext);

    const handleHostContextChanged = (
      params: McpUiHostContextChangedNotification["params"]
    ) => {
      setHostContext((previous) =>
        mergeHostContext(previous ?? app.getHostContext(), params)
      );
    };

    app.onhostcontextchanged = handleHostContextChanged;
    return () => {
      app.onhostcontextchanged = () => {};
    };
  }, [app]);

  useEffect(() => {
    if (hostContext) {
      applyHostContextToDocument(hostContext);
    }
  }, [hostContext]);

  const activeTheme = getResolvedTheme(hostContext, documentTheme);

  return {
    app,
    error,
    toolResult,
    hostContext,
    isDark: activeTheme === "dark",
    themePreset: getThemePreset(hostContext),
  };
}

export function Shell({
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
      data-theme={isDark ? "dark" : "light"}
      style={style}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        {children}
      </div>
    </main>
  );
}

export function MessageBox({
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

export function McpJamLogo({ isDark }: { isDark: boolean }) {
  return (
    <img
      src={isDark ? mcpJamDarkLogoUrl : mcpJamLightLogoUrl}
      alt="MCPJam"
      className="h-5 w-auto shrink-0 object-contain sm:h-6"
    />
  );
}

export function getResultText(result: CallToolResult): string | undefined {
  const textBlock = result.content?.find((entry) => entry.type === "text");

  return textBlock?.type === "text" ? textBlock.text : undefined;
}

// Machine-readable error code the worker attaches to error results
// (`structuredContent.error.code`), so the widget can distinguish an empty
// state (NOT_FOUND) from a real failure. Returns undefined for ok results or
// errors that carry no code.
export function getResultErrorCode(
  result: CallToolResult
): string | undefined {
  const structured = result.structuredContent as
    | { error?: { code?: unknown } }
    | undefined;
  const code = structured?.error?.code;
  return typeof code === "string" ? code : undefined;
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

function getResolvedTheme(
  hostContext: McpUiHostContext | undefined,
  fallback: "light" | "dark"
): "light" | "dark" {
  return hostContext?.theme === "light" || hostContext?.theme === "dark"
    ? hostContext.theme
    : fallback;
}

function applyHostContextToDocument(context: Partial<McpUiHostContext>) {
  if (context.theme === "light" || context.theme === "dark") {
    applyDocumentTheme(context.theme);
  }

  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }

  if (context.styles?.css?.fonts) {
    applyHostFonts(context.styles.css.fonts);
  }
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

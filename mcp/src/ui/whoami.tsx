import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WhoamiPayload } from "../shared/whoami.js";
import "./global.css";
import styles from "./whoami.module.css";

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

  if (error) {
    return (
      <Shell hostContext={hostContext}>
        <MessageBox label="App error" message={error.message} />
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
      <WhoamiContent toolResult={toolResult} />
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
      className={styles.shell}
      style={{
        paddingTop: hostContext?.safeAreaInsets?.top ?? undefined,
        paddingRight: hostContext?.safeAreaInsets?.right ?? undefined,
        paddingBottom: hostContext?.safeAreaInsets?.bottom ?? undefined,
        paddingLeft: hostContext?.safeAreaInsets?.left ?? undefined,
      }}
    >
      <div className={styles.panel}>{children}</div>
    </main>
  );
}

function WhoamiContent({
  toolResult,
}: {
  toolResult: CallToolResult | null;
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
      />
    );
  }

  const payload = toolResult.structuredContent as WhoamiPayload | undefined;
  if (!payload) {
    return (
      <MessageBox
        label="Missing structured content"
        message="The whoami tool did not include structured content for the UI view."
      />
    );
  }

  const userRecord = asRecord(payload.user);
  const displayName = getStringValue(userRecord, "name") ?? "Authenticated MCPJam user";
  const displayEmail =
    getStringValue(userRecord, "email") ?? "No email field was returned";
  const createdAt =
    getStringValue(userRecord, "createdAt") ??
    getStringValue(userRecord, "_creationTime") ??
    "Not provided";

  return (
    <>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Authenticated identity</p>
          <h1 className={styles.title}>{displayName}</h1>
          <p className={styles.subtitle}>
            The same bearer token accepted by the MCP server was forwarded to Convex.
          </p>
        </div>
        <span className={styles.statusPill}>whoami</span>
      </header>

      <section className={styles.card}>
        <p className={styles.identityLine}>{displayEmail}</p>
        <p className={styles.secondaryLine}>
          Convex resolved this session to the MCPJam user record below.
        </p>

        <div className={styles.factGrid}>
          <div className={styles.fact}>
            <span className={styles.factLabel}>User ID</span>
            <span className={styles.factValue}>{payload.id}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Created</span>
            <span className={styles.factValue}>{createdAt}</span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Raw JSON</h2>
        <pre className={styles.json}>
          <code>{JSON.stringify(payload, null, 2)}</code>
        </pre>
      </section>
    </>
  );
}

function MessageBox({
  label,
  message,
}: {
  label: string;
  message: string;
}) {
  return (
    <section className={styles.messageBox}>
      <strong>{label}</strong>
      <span>{message}</span>
    </section>
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WhoamiApp />
  </StrictMode>
);

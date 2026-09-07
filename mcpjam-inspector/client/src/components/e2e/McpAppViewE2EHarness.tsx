import { useCallback, useMemo, useState } from "react";
import { SandboxedIframe } from "@/components/ui/sandboxed-iframe";

/**
 * Dev-only harness for the MCP App view-mount e2e.
 *
 * It mounts a `SandboxedIframe` directly rather than driving the full
 * chat/renderer path, because the properties under test all live in the
 * sandbox layer: the URL the view's document ends up with, the `Referer` a
 * third party receives, whether the injected CSP still binds after the HTML is
 * written, and whether a widget's own `location.reload()` restarts it. None of
 * those can be observed in jsdom — `document.open()` there neither adopts the
 * entry document's URL nor enforces a policy — so a real browser is the only
 * place they can be pinned.
 *
 * What this deliberately does NOT cover: the renderer's lifecycle/`applied`
 * plumbing and the Sandbox Stack origin chip, which are asserted in the
 * component tests where they can be driven directly.
 */

interface ViewModeEvent {
  mode: string;
  url: string;
}

interface CspViolationEvent {
  directive: string;
  blockedUri: string;
}

declare global {
  interface Window {
    __mcpAppViewE2E?: {
      viewModes: ViewModeEvent[];
      cspViolations: CspViolationEvent[];
    };
  }
}

function record(
  update: (state: NonNullable<Window["__mcpAppViewE2E"]>) => void,
) {
  const state = (window.__mcpAppViewE2E ??= {
    viewModes: [],
    cspViolations: [],
  });
  update(state);
}

/**
 * The widget under test. It calls the fixture (so the fixture can record what
 * the browser said about the caller) and then a host that the declared CSP
 * does not allow (so the injected policy has something to refuse). Both run at
 * parse time, which is also what proves the CSP `<meta>` bound during the
 * write rather than after it.
 */
function buildWidgetHtml(
  fixtureOrigin: string,
  blockedUrl: string,
  withDoctype: boolean,
): string {
  return `${withDoctype ? "<!doctype html>\n" : ""}<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <p id="widget-marker">mcp app view e2e</p>
    <script>
      fetch(${JSON.stringify(fixtureOrigin)} + "/echo")
        .then(function () { window.__fixtureFetched = true; })
        .catch(function () { window.__fixtureFetched = false; });
      fetch(${JSON.stringify(blockedUrl)}).catch(function () {});
    </script>
  </body>
</html>`;
}

export function McpAppViewE2EHarness() {
  const params = new URLSearchParams(window.location.search);
  const fixtureOrigin = params.get("fixture") ?? "";
  const mountMode = params.get("mount") === "srcdoc" ? "srcdoc" : "write";
  // A written document without a doctype lands in quirks mode, which a srcdoc
  // document never did. The e2e pins that as a deliberate fidelity choice.
  const withDoctype = params.get("doctype") !== "none";
  // A host the declared CSP omits. `.invalid` is reserved by RFC 2606, so the
  // request can only ever be refused by the policy, never by DNS luck.
  const blockedUrl = "https://blocked.invalid/probe";

  const [reloadNonce, setReloadNonce] = useState(0);
  const html = useMemo(
    () => buildWidgetHtml(fixtureOrigin, blockedUrl, withDoctype),
    [fixtureOrigin, withDoctype],
  );

  const onMessage = useCallback((event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "mcpjam:view-mode") {
      record((state) =>
        state.viewModes.push({ mode: data.mode, url: data.url }),
      );
      return;
    }
    if (data.type === "mcp-apps:csp-violation") {
      record((state) =>
        state.cspViolations.push({
          directive: data.directive,
          blockedUri: data.blockedUri,
        }),
      );
    }
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 14 }}>MCP App view e2e harness</h1>
      <button
        type="button"
        data-testid="remount"
        onClick={() => setReloadNonce((n) => n + 1)}
      >
        remount
      </button>
      <div style={{ width: 600, height: 300 }}>
        <SandboxedIframe
          key={reloadNonce}
          html={html}
          onMessage={onMessage}
          mountMode={mountMode}
          // Only the fixture is declared, so the widget's second fetch has to
          // be refused by the policy the proxy injected.
          csp={{ connectDomains: [fixtureOrigin] }}
          permissive={false}
          title="MCP App view e2e"
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}

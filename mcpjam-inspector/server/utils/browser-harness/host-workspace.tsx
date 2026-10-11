import { UserMessageBubble } from "@/components/chat-v2/thread/user-message-bubble";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { hostComposerClasses } from "@/lib/host-composer-presentation";
import { HostStyledShell } from "@/components/chat-v2/host-styled-shell";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { RunHostWorkspace } from "@/components/plugin-workspace/unattended/RunHostWorkspace";
import "./host-workspace.css";

import type { HarnessPresentation } from "../../../shared/unattended-workspace";
/** Existing bridge owns the only live iframe. Updating text never remounts its panel. */
export function mountHarnessWorkspace(container: HTMLElement) {
  let panel: HTMLDivElement | null = null;
  const root = createRoot(container);
  function update(presentation: HarnessPresentation = {}) {
    const messages = Array.isArray(presentation.messages)
      ? presentation.messages
          .slice(-100)
          .filter(
            (message) =>
              message &&
              (message.role === "app" ||
                ((message.role === "user" || message.role === "assistant") &&
                  typeof message.text === "string")),
          )
      : [];
    container.classList.toggle("dark", presentation.theme === "dark");
    flushSync(() =>
      root.render(
        <PreferencesStoreProvider
          themeMode={presentation.theme ?? "light"}
          themePreset="default"
        >
          <HostStyledShell
            hostSnapshot={hostSnapshotFromStyle(presentation.hostStyle)}
            activeHost={null}
            themeMode={presentation.theme ?? "light"}
            className="run-host-shell"
          >
            <RunHostWorkspace
              appOpen
              transcript={
                <div className="run-conversation">
                  <div className="run-transcript">
                    {messages.map((message, index) =>
                      message.role === "app" ? (
                        <p key={index} data-widget-placeholder="true">
                          App is displayed in the workspace.
                        </p>
                      ) : (
                        <div
                          key={index}
                          data-role={message.role}
                          className="mb-6 text-base leading-7"
                        >
                          {message.role === "user" ? (
                            <UserMessageBubble>
                              {message.text.slice(0, 8192)}
                            </UserMessageBubble>
                          ) : (
                            <p className="whitespace-pre-wrap">
                              {message.text.slice(0, 8192)}
                            </p>
                          )}
                        </div>
                      ),
                    )}
                    <span data-widget-placeholder="true">
                      App is displayed in the workspace.
                    </span>
                  </div>
                  <div className="run-composer">
                    <div
                      className={hostComposerClasses(
                        presentation.hostStyle,
                        presentation.theme === "dark",
                      )}
                      data-testid="chat-input-composer"
                    >
                      <TextareaAutosize
                        aria-label="Message"
                        placeholder="Run in progress"
                        disabled
                        readOnly
                        minRows={2}
                        className="min-h-[64px] w-full resize-none border-none bg-transparent px-4 pt-3 pb-3 text-base text-foreground placeholder:text-muted-foreground/70 outline-none shadow-none"
                      />
                    </div>
                  </div>
                </div>
              }
              appPanel={
                <div className="run-app-panel">
                  <div className="run-app-heading">App</div>
                  <div
                    className="run-app-content"
                    ref={(element) => {
                      panel = element;
                    }}
                  />
                </div>
              }
            />
          </HostStyledShell>
        </PreferencesStoreProvider>,
      ),
    );
  }
  update();
  if (!panel) throw new Error("Harness workspace did not mount");
  return { panel: panel as HTMLDivElement, update };
}

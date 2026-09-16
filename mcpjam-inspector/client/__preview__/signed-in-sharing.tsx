import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import { ScenarioSignInGate } from "../src/components/hosted/ScenarioSignInGate";
import { ShareDialog } from "../src/components/sharing/ShareDialog";
import { ShareSection } from "../src/components/sharing/ShareSection";
import { buildScenarioLink } from "../src/lib/scenario-session";
import { SCENARIO_ACCESS_OPTIONS } from "../src/lib/scenario-access-presets";
import { Button } from "@mcpjam/design-system/button";

const sampleShareUrl = buildScenarioLink("preview-example", "checkout-study");

function Preview() {
  const [view, setView] = useState(
    new URLSearchParams(location.search).get("view") ?? "gate",
  );
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const [preset, setPreset] = useState("link_guests");
  const [notice, setNotice] = useState("");
  return (
    <div className={dark ? "dark" : ""}>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-8 py-5">
          <div>
            <strong className="text-lg tracking-tight">MCPJam</strong>
            <span className="ml-4 text-xs">UI preview · Sample data</span>
          </div>
          <nav className="flex gap-2" aria-label="Preview controls">
            <Button variant="outline" onClick={() => setView("gate")}>
              Tester sign-in
            </Button>
            <Button variant="outline" onClick={() => setView("share")}>
              Owner sharing
            </Button>
            <Button variant="outline" onClick={() => setDark(!dark)}>
              {dark ? "Light mode" : "Dark mode"}
            </Button>
          </nav>
        </header>
        <ScenarioSignInGate
          onSignIn={() =>
            setNotice(
              "In the app, this opens sign-in and returns to the original scenario link.",
            )
          }
          onSignUp={() =>
            setNotice(
              "In the app, this opens account creation and returns to the original scenario link.",
            )
          }
        />
        {notice && (
          <p role="status" className="px-8 pb-6 text-center text-sm">
            {notice}
          </p>
        )}
        <ShareDialog
          open={view === "share"}
          onOpenChange={() => setView("gate")}
          title="Share this study with your users"
        >
          <ShareSection
            envelope={{}}
            isAuthenticated
            displayName="Study owner"
            displayEmail="owner@example.com"
            selfEmailLower="owner@example.com"
            members={[]}
            showMembers={false}
            shareUrl={sampleShareUrl}
            displayLink={sampleShareUrl.replace(/^https?:\/\//, "")}
            currentPreset={preset}
            presets={SCENARIO_ACCESS_OPTIONS}
            onSetPreset={async (value) => {
              setPreset(value);
              return {};
            }}
            onInvite={async () => ({})}
            onRemoveMember={async () => ({})}
            activeNote={
              preset === "link_guests" ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Testers must sign in or create an account to preview and test
                  this scenario.
                </p>
              ) : null
            }
            copy={{
              linkLabel: "Tester link",
              signedOutMessage: "Sign in to manage scenario access.",
              withheldLabel: "Withheld",
              rotateConfirmTitle: "Rotate this tester link?",
              rotateConfirmBody:
                "Anyone with the old URL will no longer be able to redeem it.",
            }}
            testIds={{
              copy: "scenario-copy-tester-link",
              email: "scenario-share-email",
              linkOutput: "scenario-tester-link",
            }}
          />
        </ShareDialog>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

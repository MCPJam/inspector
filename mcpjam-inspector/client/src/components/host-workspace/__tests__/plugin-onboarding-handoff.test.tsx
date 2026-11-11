import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginOnboardingHandoff } from "../plugin-onboarding-handoff";
import { usePluginOnboardingIntentStore } from "@/lib/plugin-onboarding-intent";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

const request = () => usePluginOnboardingIntentStore.getState().request({
  projectId: "project", serverIds: ["server"], pluginId: "plugin",
  pluginName: "Fixture", conversation: "new",
});

describe("onboarding handoff in Compare", () => {
  beforeEach(() => {
    usePluginOnboardingIntentStore.getState().clear();
    useTrafficLogStore.getState().clear();
  });
  afterEach(() => usePluginOnboardingIntentStore.getState().clear());

  it("refuses once and requires a fresh request after switching to a single chat", () => {
    request();
    const view = render(<StrictMode><PluginOnboardingHandoff projectId="project" compareActive /></StrictMode>);
    expect(screen.getByRole("alert")).toHaveTextContent("Setup did not start in Compare.");
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
    const notices = useTrafficLogStore.getState().mcpServerItems.filter(
      (item) => item.method === "plugin-extensions/PLUGIN_ONBOARDING_NOT_STARTED",
    );
    expect(notices).toHaveLength(1);
    view.rerender(<StrictMode><PluginOnboardingHandoff projectId="project" compareActive={false} /></StrictMode>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
    act(() => { request(); });
    expect(usePluginOnboardingIntentStore.getState().intent?.projectId).toBe("project");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves another project's request untouched and shows no empty refusal", () => {
    const view = render(<PluginOnboardingHandoff projectId={null} compareActive />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    let requestId = "";
    act(() => { requestId = request().id; });
    view.rerender(<PluginOnboardingHandoff projectId="other" compareActive />);
    expect(usePluginOnboardingIntentStore.getState().intent?.id).toBe(requestId);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

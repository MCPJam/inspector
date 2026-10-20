import { lazy } from "react";

// Route bodies outside the core landing routes (home, servers, playground,
// tools). Each loads on first visit, so a cold load does not download and
// parse every feature before the first real paint.
export const ApiKeysRoute = lazy(() =>
  import("./components/settings/ApiKeysRoute").then((m) => ({
    default: m.ApiKeysRoute,
  })),
);
export const BenchResultsPage = lazy(() =>
  import("./components/score/BenchResultsPage").then((m) => ({
    default: m.BenchResultsPage,
  })),
);
export const BenchRunnerPage = lazy(() =>
  import("./components/score/BenchRunnerPage").then((m) => ({
    default: m.BenchRunnerPage,
  })),
);
export const CaniuseCapabilityPage = lazy(() =>
  import("./components/hosts/comparison/CaniuseCapabilityPage").then((m) => ({
    default: m.CaniuseCapabilityPage,
  })),
);
export const CiEvalsTab = lazy(() =>
  import("./components/CiEvalsTab").then((m) => ({ default: m.CiEvalsTab })),
);
export const ComputerTabView = lazy(() =>
  import("./components/computer/ComputerTabView").then((m) => ({
    default: m.ComputerTabView,
  })),
);
export const ConformanceHistory = lazy(() =>
  import("./components/conformance/ConformanceHistory").then((m) => ({
    default: m.ConformanceHistory,
  })),
);
export const ConformanceRunDetailPage = lazy(() =>
  import("./components/conformance/ConformanceHistory").then((m) => ({
    default: m.ConformanceRunDetailPage,
  })),
);
export const ConformanceSharedPage = lazy(() =>
  import("./components/conformance/ConformanceHistory").then((m) => ({
    default: m.ConformanceSharedPage,
  })),
);
export const ConformanceTab = lazy(() =>
  import("./components/conformance/ConformancePanel").then((m) => ({
    default: m.ConformanceTab,
  })),
);
export const EvalRunSharedPage = lazy(() =>
  import("./components/evals/EvalRunSharedPage").then((m) => ({
    default: m.EvalRunSharedPage,
  })),
);
export const EvalsTab = lazy(() =>
  import("./components/EvalsTab").then((m) => ({ default: m.EvalsTab })),
);
export const EvaluateTab = lazy(() =>
  import("./components/EvaluateTab").then((m) => ({ default: m.EvaluateTab })),
);
export const GithubChecksRoute = lazy(() =>
  import("./components/settings/GithubChecksRoute").then((m) => ({
    default: m.GithubChecksRoute,
  })),
);
export const GithubInstallCallbackRoute = lazy(() =>
  import("./components/settings/GithubInstallCallbackRoute").then((m) => ({
    default: m.GithubInstallCallbackRoute,
  })),
);
export const HostCompatPage = lazy(() =>
  import("./components/compat/HostCompatPage").then((m) => ({
    default: m.HostCompatPage,
  })),
);
export const HostConfigCompareView = lazy(() =>
  import("./components/hosts/comparison/HostConfigCompareView").then((m) => ({
    default: m.HostConfigCompareView,
  })),
);
export const IntegrationsRoute = lazy(() =>
  import("./components/settings/IntegrationsRoute").then((m) => ({
    default: m.IntegrationsRoute,
  })),
);
export const LearningTab = lazy(() =>
  import("./components/LearningTab").then((m) => ({ default: m.LearningTab })),
);
export const OAuthFlowTab = lazy(() =>
  import("./components/OAuthFlowTab").then((m) => ({
    default: m.OAuthFlowTab,
  })),
);
export const OrganizationsTab = lazy(() =>
  import("./components/OrganizationsTab").then((m) => ({
    default: m.OrganizationsTab,
  })),
);
export const ProfileTab = lazy(() =>
  import("./components/ProfileTab").then((m) => ({ default: m.ProfileTab })),
);
export const ProjectEnvironmentsRoute = lazy(() =>
  import("./components/project-environments/ProjectEnvironmentsRoute").then(
    (m) => ({ default: m.ProjectEnvironmentsRoute }),
  ),
);
export const ProjectSettingsTab = lazy(() =>
  import("./components/ProjectSettingsTab").then((m) => ({
    default: m.ProjectSettingsTab,
  })),
);
export const RegistryTab = lazy(() =>
  import("./components/RegistryTab").then((m) => ({ default: m.RegistryTab })),
);
export const ScoreResultsPage = lazy(() =>
  import("./components/score/ScoreResultsPage").then((m) => ({
    default: m.ScoreResultsPage,
  })),
);
export const ScoreRunnerPage = lazy(() =>
  import("./components/score/ScoreRunnerPage").then((m) => ({
    default: m.ScoreRunnerPage,
  })),
);
export const SessionsPanel = lazy(() =>
  import("./components/sessions/SessionsPanel").then((m) => ({
    default: m.SessionsPanel,
  })),
);
export const SettingsTab = lazy(() =>
  import("./components/SettingsTab").then((m) => ({ default: m.SettingsTab })),
);
export const SkillsTab = lazy(() =>
  import("./components/SkillsTab").then((m) => ({ default: m.SkillsTab })),
);
export const SupportTab = lazy(() =>
  import("./components/SupportTab").then((m) => ({ default: m.SupportTab })),
);
export const SwarmsTab = lazy(() =>
  import("./components/swarms/SwarmsTab").then((m) => ({
    default: m.SwarmsTab,
  })),
);
export const TasksTab = lazy(() =>
  import("./components/TasksTab").then((m) => ({ default: m.TasksTab })),
);
export const TracingTab = lazy(() =>
  import("./components/TracingTab").then((m) => ({ default: m.TracingTab })),
);
export const UserTestingTab = lazy(() =>
  import("./components/UserTestingTab").then((m) => ({
    default: m.UserTestingTab,
  })),
);
export const WebmcpInspectorTab = lazy(() =>
  import("./components/webmcp-inspector/WebmcpInspectorTab").then((m) => ({
    default: m.WebmcpInspectorTab,
  })),
);
export const XAAFlowTab = lazy(() =>
  import("./components/xaa/XAAFlowTab").then((m) => ({
    default: m.XAAFlowTab,
  })),
);

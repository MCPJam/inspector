import {
  getStepInfo,
  getStepIndex,
} from "@/lib/oauth/state-machines/shared/step-metadata";
import {
  type OAuthFlowState,
  type OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import { Circle, CheckCircle2 } from "lucide-react";

interface StepEntry {
  type: "info" | "http";
  log?: NonNullable<OAuthFlowState["infoLogs"]>[number];
  entry?: NonNullable<OAuthFlowState["httpHistory"]>[number];
}

interface StepGroup {
  step: OAuthFlowStep;
  entries: StepEntry[];
  firstTimestamp: number;
}

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString();

const getStatusIcon = (step: OAuthFlowStep, currentStepIndex: number) => {
  const index = getStepIndex(step);

  if (index === Number.MAX_SAFE_INTEGER) {
    return {
      icon: Circle,
      className: "h-4 w-4 text-muted-foreground",
      label: "Pending",
    };
  }

  if (index < currentStepIndex) {
    return {
      icon: CheckCircle2,
      className: "h-4 w-4 text-green-600 dark:text-green-400",
      label: "Complete",
    };
  }

  if (index === currentStepIndex) {
    return {
      icon: CheckCircle2,
      className: "h-4 w-4 text-green-600 dark:text-green-400",
      label: "Complete",
    };
  }

  return {
    icon: Circle,
    className: "h-4 w-4 text-muted-foreground",
    label: "Pending",
  };
};

export function generateGuideText(
  oauthFlowState: OAuthFlowState,
  groups: StepGroup[],
): string {
  let text = "=== OAuth Debugger - Guide View ===\n\n";

  if (oauthFlowState.error) {
    text += `ERROR: ${oauthFlowState.error}\n\n`;
  }

  if (groups.length === 0) {
    text += "No activity yet.\n";
    return text;
  }

  const currentStepIndex = getStepIndex(oauthFlowState.currentStep);

  groups.forEach((group, groupIndex) => {
    const info = getStepInfo(group.step);
    const stepNumber = groupIndex + 1;
    const statusInfo = getStatusIcon(group.step, currentStepIndex);

    text += `\n${"=".repeat(60)}\n`;
    text += `${stepNumber}. ${info.title} [${statusInfo.label}]\n`;
    text += `${"=".repeat(60)}\n`;
    text += `${info.summary}\n\n`;

    // Add teachable moments
    if (info.teachableMoments && info.teachableMoments.length > 0) {
      text += "What to pay attention to:\n";
      info.teachableMoments.forEach((moment) => {
        text += `  - ${moment}\n`;
      });
      text += "\n";
    }

    // Add tips
    if (info.tips && info.tips.length > 0) {
      text += "Tips:\n";
      info.tips.forEach((tip) => {
        text += `  - ${tip}\n`;
      });
      text += "\n";
    }

    // Add entries
    group.entries.forEach((entry) => {
      if (entry.type === "info" && entry.log) {
        const log = entry.log;
        text += `[${formatTimestamp(log.timestamp)}] ${log.label || "Info"}\n`;
        if (log.data) {
          text += `${JSON.stringify(log.data, null, 2)}\n`;
        }
        if (log.error) {
          text += `ERROR: ${log.error.message}\n`;
        }
        text += "\n";
      } else if (entry.type === "http" && entry.entry) {
        const httpEntry = entry.entry;
        text += `[${formatTimestamp(httpEntry.timestamp)}] ${httpEntry.request.method} ${httpEntry.request.url}\n`;

        if (httpEntry.duration) {
          text += `Duration: ${httpEntry.duration}ms\n`;
        }

        if (httpEntry.response?.status) {
          text += `Status: ${httpEntry.response.status} ${httpEntry.response.statusText || ""}\n`;
        }

        // Request details
        if (
          httpEntry.request.headers &&
          Object.keys(httpEntry.request.headers).length > 0
        ) {
          text += "\nRequest Headers:\n";
          text += `${JSON.stringify(httpEntry.request.headers, null, 2)}\n`;
        }

        if (httpEntry.request.body) {
          text += "\nRequest Body:\n";
          text += `${typeof httpEntry.request.body === "string" ? httpEntry.request.body : JSON.stringify(httpEntry.request.body, null, 2)}\n`;
        }

        // Response details
        if (
          httpEntry.response?.headers &&
          Object.keys(httpEntry.response.headers).length > 0
        ) {
          text += "\nResponse Headers:\n";
          text += `${JSON.stringify(httpEntry.response.headers, null, 2)}\n`;
        }

        if (httpEntry.response?.body) {
          text += "\nResponse Body:\n";
          text += `${typeof httpEntry.response.body === "string" ? httpEntry.response.body : JSON.stringify(httpEntry.response.body, null, 2)}\n`;
        }

        if (httpEntry.error) {
          text += `\nERROR: ${httpEntry.error.message}\n`;
          if (httpEntry.error.stack) {
            text += `Stack: ${httpEntry.error.stack}\n`;
          }
        }
        text += "\n";
      }
    });
  });

  return text;
}

export function generateRawText(
  oauthFlowState: OAuthFlowState,
  timelineEntries: Array<
    | {
        type: "info";
        timestamp: number;
        log: NonNullable<OAuthFlowState["infoLogs"]>[number];
        key: string;
      }
    | {
        type: "http";
        timestamp: number;
        entry: NonNullable<OAuthFlowState["httpHistory"]>[number];
        key: string;
      }
  >,
): string {
  let text = "=== OAuth Debugger - Raw Logs ===\n\n";

  if (timelineEntries.length === 0) {
    text += "No activity yet.\n";
    return text;
  }

  timelineEntries.forEach((entry) => {
    if (entry.type === "info") {
      const log = entry.log;
      const level = log.level ?? "info";
      text += `[${formatTimestamp(log.timestamp)}] [${level.toUpperCase()}] ${log.step}\n`;
      text += `${log.label || "Info"}\n`;
      if (log.data) {
        text += `${JSON.stringify(log.data, null, 2)}\n`;
      }
      if (log.error) {
        text += `ERROR: ${log.error.message}\n`;
        if (log.error.stack) {
          text += `Stack: ${log.error.stack}\n`;
        }
      }
      text += "\n";
    } else {
      const httpEntry = entry.entry;
      const status = httpEntry.response?.status;
      const statusLabel =
        status !== undefined
          ? `${status}${httpEntry.response?.statusText ? ` ${httpEntry.response?.statusText}` : ""}`
          : "pending";

      text += `[${formatTimestamp(httpEntry.timestamp)}] [${httpEntry.request.method}] [${statusLabel}] ${httpEntry.step}\n`;
      text += `URL: ${httpEntry.request.url}\n`;

      if (httpEntry.duration) {
        text += `Duration: ${httpEntry.duration}ms\n`;
      }

      // Request details
      if (
        httpEntry.request.headers &&
        Object.keys(httpEntry.request.headers).length > 0
      ) {
        text += "\nRequest Headers:\n";
        text += `${JSON.stringify(httpEntry.request.headers, null, 2)}\n`;
      }

      if (httpEntry.request.body) {
        text += "\nRequest Body:\n";
        text += `${typeof httpEntry.request.body === "string" ? httpEntry.request.body : JSON.stringify(httpEntry.request.body, null, 2)}\n`;
      }

      // Response details
      if (
        httpEntry.response?.headers &&
        Object.keys(httpEntry.response.headers).length > 0
      ) {
        text += "\nResponse Headers:\n";
        text += `${JSON.stringify(httpEntry.response.headers, null, 2)}\n`;
      }

      if (httpEntry.response?.body) {
        text += "\nResponse Body:\n";
        text += `${typeof httpEntry.response.body === "string" ? httpEntry.response.body : JSON.stringify(httpEntry.response.body, null, 2)}\n`;
      }

      if (httpEntry.error) {
        text += `\nERROR: ${httpEntry.error.message}\n`;
        if (httpEntry.error.stack) {
          text += `Stack: ${httpEntry.error.stack}\n`;
        }
      }
      text += "\n";
    }
  });

  return text;
}

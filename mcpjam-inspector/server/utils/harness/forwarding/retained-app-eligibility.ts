/** App resource ownership is independent of native-forwarding qualification. */
export function retainedAppResourcesEligible(input: {
  plane: string | undefined;
  delivery: "host-tools" | "mcp-endpoint";
  chatSessionId?: string;
  hostRendersApps: boolean;
  scenarioId?: string;
  evalIterationId?: string;
  journeyRunId?: string;
  localExecution: boolean;
}): boolean {
  return input.plane === "web-authorized" &&
    input.delivery === "host-tools" &&
    !!input.chatSessionId && input.hostRendersApps &&
    !input.scenarioId && !input.evalIterationId && !input.journeyRunId &&
    !input.localExecution;
}

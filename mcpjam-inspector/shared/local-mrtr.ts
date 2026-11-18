export interface MrtrBridgeInputRequest {
  key: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: Record<string, unknown>;
  pluginForm?: boolean;
  url?: string;
}

export interface MrtrRound {
  opId: string;
  roundKey: string;
  round: number;
  serverId?: string;
  requests: MrtrBridgeInputRequest[];
  timestamp: string;
}

export type MrtrRoundEvent = MrtrRound & {
  type: "mrtr_input_request";
  serverId: string;
};

export type MrtrKeyAnswer = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

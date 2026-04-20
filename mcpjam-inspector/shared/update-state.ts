export type UpdatePhase =
  | "idle"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  installRequested: boolean;
  version?: string;
  releaseNotes?: string;
  errorMessage?: string;
}

export const IDLE_UPDATE_STATE: UpdateState = {
  phase: "idle",
  installRequested: false,
};

export class SandboxViewAdmissionError extends Error {
  constructor(readonly retryable = false) {
    super("Could not open this App securely. Close it and try again.");
    this.name = "SandboxViewAdmissionError";
  }
}

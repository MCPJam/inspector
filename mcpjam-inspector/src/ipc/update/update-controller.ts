import { IDLE_UPDATE_STATE, type UpdateState } from "../../../shared/update-state.js";

interface LoggerLike {
  info(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
}

interface UpdaterLike {
  on(event: "checking-for-update", listener: () => void): this;
  on(event: "update-available", listener: () => void): this;
  on(event: "update-not-available", listener: () => void): this;
  on(
    event: "update-downloaded",
    listener: (
      event: unknown,
      releaseNotes?: string | null,
      releaseName?: string | null,
    ) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

interface UpdateControllerOptions {
  updater: UpdaterLike;
  logger: LoggerLike;
  onStateChange?: (state: UpdateState) => void;
}

export class UpdateController {
  private readonly updater: UpdaterLike;
  private readonly logger: LoggerLike;
  private readonly onStateChange?: (state: UpdateState) => void;
  private state: UpdateState = { ...IDLE_UPDATE_STATE };
  private started = false;

  constructor({ updater, logger, onStateChange }: UpdateControllerOptions) {
    this.updater = updater;
    this.logger = logger;
    this.onStateChange = onStateChange;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;

    this.updater.on("checking-for-update", () => {
      this.logger.info("Checking for updates...");
    });

    this.updater.on("update-available", () => {
      this.logger.info("Update available, downloading...");

      this.setState({
        ...this.state,
        phase: this.state.installRequested ? "downloading" : "available",
        errorMessage: undefined,
      });
    });

    this.updater.on("update-downloaded", (_event, releaseNotes, releaseName) => {
      this.logger.info(`Update downloaded: ${releaseName ?? "new version"}`);

      const nextState: UpdateState = {
        phase: "ready",
        installRequested: this.state.installRequested,
        version: releaseName ?? this.state.version,
        releaseNotes: releaseNotes ?? this.state.releaseNotes,
      };

      this.setState(nextState);

      if (nextState.installRequested) {
        this.applyUpdate();
      }
    });

    this.updater.on("update-not-available", () => {
      this.logger.info("No updates available");

      if (this.state.phase === "idle") {
        this.setState({ ...IDLE_UPDATE_STATE });
      }
    });

    this.updater.on("error", (error) => {
      this.handleUpdateError(error);
    });
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  requestInstall(): void {
    switch (this.state.phase) {
      case "ready":
        this.applyUpdate();
        return;
      case "available":
      case "downloading":
        this.setState({
          ...this.state,
          phase: "downloading",
          installRequested: true,
          errorMessage: undefined,
        });
        return;
      case "error":
        this.retryInstall();
        return;
      default:
        return;
    }
  }

  simulateReady(): void {
    this.setState({
      phase: "ready",
      installRequested: false,
      version: "99.0.0",
      releaseNotes: "Simulated update for testing",
    });
  }

  private retryInstall(): void {
    this.setState({
      ...this.state,
      phase: "downloading",
      installRequested: true,
      errorMessage: undefined,
    });

    try {
      this.updater.checkForUpdates();
    } catch (error) {
      this.handleUpdateError(error);
    }
  }

  private applyUpdate(): void {
    this.logger.info("Restarting app to install update...");

    try {
      this.updater.quitAndInstall();
    } catch (error) {
      this.handleUpdateError(error);
    }
  }

  private handleUpdateError(error: unknown): void {
    const normalizedError = normalizeError(error);
    this.logger.error("Auto-updater error:", normalizedError);

    if (this.state.phase === "idle" && !this.state.installRequested) {
      return;
    }

    this.setState({
      ...this.state,
      phase: "error",
      installRequested: false,
      errorMessage: normalizedError.message,
    });
  }

  private setState(nextState: UpdateState): void {
    if (statesAreEqual(this.state, nextState)) {
      return;
    }

    this.state = nextState;
    this.onStateChange?.(this.getState());
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function statesAreEqual(a: UpdateState, b: UpdateState): boolean {
  return (
    a.phase === b.phase &&
    a.installRequested === b.installRequested &&
    a.version === b.version &&
    a.releaseNotes === b.releaseNotes &&
    a.errorMessage === b.errorMessage
  );
}

import { afterEach, describe, expect, it, vi } from "vitest";

const { childProcessIntegration, onUncaughtExceptionIntegration } = vi.hoisted(
  () => ({
    childProcessIntegration: vi.fn((options: unknown) => ({
      name: "ChildProcess",
      options,
    })),
    onUncaughtExceptionIntegration: vi.fn((options: unknown) => ({
      name: "OnUncaughtException",
      options,
    })),
  }),
);

vi.mock("@sentry/electron/main", () => ({
  childProcessIntegration,
  onUncaughtExceptionIntegration,
}));

import {
  CAPTURED_EXIT_REASONS,
  childProcessIntegrationOptions,
  crashReportingIntegrations,
  dropUpdaterInstallSpawnRejection,
  isUpdaterInstallSpawnRejection,
  registerMainProcessCrashHandlers,
} from "./crash-reporting";

describe("childProcessIntegrationOptions", () => {
  it("promotes the crash-shaped reasons the SDK leaves as breadcrumbs", () => {
    // @sentry/electron 5.12 defaults `events` to abnormal-exit,
    // launch-failed and integrity-failure only. crashed/oom are
    // exactly the ones a desktop user experiences as "the app broke".
    const { events } = childProcessIntegrationOptions();
    expect(events).toContain("crashed");
    expect(events).toContain("oom");
  });

  it("never captures an OS kill, leaving it a breadcrumb", () => {
    // macOS kills Electron's own utility processes under memory pressure and
    // Electron respawns them; the user sees nothing. Capturing it filed
    // issues about the reporter's machine, not about the app.
    const { events } = childProcessIntegrationOptions();
    expect(events).not.toContain("killed");
  });

  it("keeps the SDK's own defaults", () => {
    const { events } = childProcessIntegrationOptions();
    expect(events).toContain("abnormal-exit");
    expect(events).toContain("launch-failed");
    expect(events).toContain("integrity-failure");
  });

  it("never captures a clean exit", () => {
    expect(CAPTURED_EXIT_REASONS).not.toContain("clean-exit");
  });
});

describe("crashReportingIntegrations", () => {
  it("replaces the default ChildProcess integration rather than adding a second", () => {
    // Registering our own app.on("render-process-gone") alongside the default
    // would double-report every reason the integration already covers.
    const result = crashReportingIntegrations([
      { name: "SentryMinidump" },
      { name: "ChildProcess" },
      { name: "OnUncaughtException" },
    ]);

    expect(result.filter((i) => i.name === "ChildProcess")).toHaveLength(1);
    expect(result.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        "SentryMinidump",
        "OnUncaughtException",
        "ChildProcess",
      ]),
    );
  });

  it("forces the uncaught-exception exit, exactly once", () => {
    // registerMainProcessCrashHandlers adds an uncaughtException listener, so
    // Sentry's default would decline to exit and leave the app running in an
    // undefined state after a fatal main-process error.
    onUncaughtExceptionIntegration.mockClear();
    const result = crashReportingIntegrations([
      { name: "OnUncaughtException" },
      { name: "ChildProcess" },
    ]);

    expect(onUncaughtExceptionIntegration).toHaveBeenCalledWith({
      exitEvenIfOtherHandlersAreRegistered: true,
    });
    expect(
      result.filter((i) => i.name === "OnUncaughtException"),
    ).toHaveLength(1);
  });

  it("leaves the native minidump integration in place", () => {
    // sentryMinidumpIntegration is default-on in 5.12; native crash upload
    // needs no wiring from us, and removing it would lose real crashes.
    const result = crashReportingIntegrations([{ name: "SentryMinidump" }]);
    expect(result.some((i) => i.name === "SentryMinidump")).toBe(true);
  });
});

describe("registerMainProcessCrashHandlers", () => {
  const added: Array<[string, (...args: never[]) => void]> = [];

  afterEach(() => {
    for (const [event, listener] of added.splice(0)) {
      process.off(event as "uncaughtException", listener as never);
    }
    vi.restoreAllMocks();
  });

  function capture() {
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      listener: (...args: never[]) => void,
    ) => {
      added.push([event, listener]);
      return process;
    }) as never);
  }

  it("registers both process-level listeners", () => {
    capture();
    registerMainProcessCrashHandlers({ error: vi.fn(), warn: vi.fn() });

    expect(added.map(([e]) => e)).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
  });

  it("writes both to the electron-log file", () => {
    capture();
    const log = { error: vi.fn(), warn: vi.fn() };
    registerMainProcessCrashHandlers(log);

    const error = new Error("main blew up");
    added[0][1](error as never);
    added[1][1]("rejected reason" as never);

    expect(log.error).toHaveBeenNthCalledWith(
      1,
      "[main] uncaught exception",
      error,
    );
    expect(log.error).toHaveBeenNthCalledWith(
      2,
      "[main] unhandled rejection",
      "rejected reason",
    );
  });

  it("logs a skipped install as its own warning, not as a rejection", () => {
    // INSPECTOR-ELECTRON-WK. The app quit cleanly and skipped one install, so
    // filing it under "unhandled rejection" describes the wrong event. It is
    // dropped from Sentry, which makes this log line the only surviving
    // record — it has to say what happened.
    capture();
    const log = { error: vi.fn(), warn: vi.fn() };
    registerMainProcessCrashHandlers(log);

    added[1][1](
      new Error(
        "AutoUpdater process with arguments --processStartAndWait,mcpjam-inspector.exe is already running",
      ) as never,
    );

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![0])).toContain(
      "offered again on the next launch",
    );
  });

  it("survives a logger that throws", () => {
    // An exception thrown from inside an uncaughtException handler is
    // unrecoverable; a failing logger must not be what kills the app.
    capture();
    registerMainProcessCrashHandlers({
      error: () => {
        throw new Error("log transport is dead");
      },
      warn: () => {
        throw new Error("log transport is dead");
      },
    });

    expect(() => added[0][1](new Error("x") as never)).not.toThrow();
    expect(() => added[1][1]("y" as never)).not.toThrow();
  });
});

describe("isUpdaterInstallSpawnRejection", () => {
  const collision = (exe: string) =>
    new Error(
      `AutoUpdater process with arguments --processStartAndWait,${exe} is already running`,
    );

  it("matches the Squirrel spawn collision Electron leaves floating", () => {
    expect(isUpdaterInstallSpawnRejection(collision("mcpjam-inspector.exe"))).toBe(
      true,
    );
    // The exe name is whatever the build is called, so it cannot be part of
    // the match.
    expect(isUpdaterInstallSpawnRejection(collision("Some Other Name.exe"))).toBe(
      true,
    );
  });

  it("reads a bare string rejection too", () => {
    // `unhandledRejection` hands over whatever was rejected with, which is not
    // required to be an Error.
    expect(
      isUpdaterInstallSpawnRejection(
        "AutoUpdater process with arguments --processStartAndWait,x.exe is already running",
      ),
    ).toBe(true);
  });

  it("leaves every other rejection alone", () => {
    // Especially the updater's OWN other failures: those are real and the
    // main process deliberately carries no `ignoreErrors`.
    expect(
      isUpdaterInstallSpawnRejection(
        new Error("No update available, can't quit and install"),
      ),
    ).toBe(false);
    expect(isUpdaterInstallSpawnRejection(new Error("Load failed"))).toBe(false);
    expect(isUpdaterInstallSpawnRejection(undefined)).toBe(false);
    expect(isUpdaterInstallSpawnRejection(null)).toBe(false);
  });
});

describe("dropUpdaterInstallSpawnRejection", () => {
  const event = (value: string) => ({
    exception: { values: [{ type: "Error", value }] },
  });

  it("drops the skipped-install rejection", () => {
    expect(
      dropUpdaterInstallSpawnRejection(
        event(
          "AutoUpdater process with arguments --processStartAndWait,mcpjam-inspector.exe is already running",
        ),
      ),
    ).toBeNull();
  });

  it("passes everything else through unchanged", () => {
    const other = event("Cannot read properties of undefined");
    expect(dropUpdaterInstallSpawnRejection(other)).toBe(other);

    // An event with no exception at all — a captureMessage, say — must not be
    // swallowed by an empty-string match.
    const message = {};
    expect(dropUpdaterInstallSpawnRejection(message)).toBe(message);
  });
});

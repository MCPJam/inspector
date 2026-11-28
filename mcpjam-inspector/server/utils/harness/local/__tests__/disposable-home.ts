/**
 * Point the harness's home-derived state at a test's temporary directory.
 *
 * `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so a suite
 * that redirects only one of them writes grants, keys and registries into the
 * developer's real `~/.mcpjam` on the other platform. Both are set here, and
 * the resolved state root is checked to be inside `home` before any test can
 * write through it.
 */
import { isAbsolute, relative } from "node:path";
import { localHarnessStateRoot } from "../grants.js";

const HOME_VARIABLES = ["HOME", "USERPROFILE"] as const;

/** Redirect both home variables to `home`; the returned function restores them. */
export function useDisposableHome(home: string): () => void {
  const saved = HOME_VARIABLES.map((name) => [name, process.env[name]] as const);
  const restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  for (const name of HOME_VARIABLES) process.env[name] = home;
  const stateRoot = localHarnessStateRoot();
  const fromHome = relative(home, stateRoot);
  if (fromHome === "" || fromHome.startsWith("..") || isAbsolute(fromHome)) {
    restore();
    throw new Error(
      `harness state root ${stateRoot} is not inside the disposable home ${home}`,
    );
  }
  return restore;
}

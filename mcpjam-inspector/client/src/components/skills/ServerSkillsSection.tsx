/**
 * "From MCP servers" — skills served over the protocol (SEP-2640).
 *
 * A self-contained section rather than rows woven into `SkillsFileTree`,
 * because these are not the same kind of thing as the skills that tree shows:
 * they are identified by URI rather than by name, they are owned by a server
 * rather than by the project, and their contents carry a verification state
 * that has no analogue for a local or Convex skill. Grouping them under their
 * origin server — with that state visible — is the whole point.
 *
 * Every read goes through the verified path, so a skill that fails a mandatory
 * check renders its specific violation instead of appearing to load.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  AlertTriangle,
  Link2,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  getApiContextRevision,
  subscribeApiContext,
} from "@/lib/apis/web/context";
import {
  getServerSkill,
  listServerSkills,
  type ServerSkillListing,
  type ServerSkillSummary,
  type VerifiedServerSkill,
  type ServerSkillRefusal,
} from "@/lib/apis/server-skills-api";

export interface ServerSkillsSectionServer {
  /** The id the manager knows this connection by. */
  serverId: string;
  /** The user-assigned label. Never `serverInfo.name`. */
  label: string;
  connected: boolean;
}

interface Props {
  servers: ServerSkillsSectionServer[];
  projectId?: string;
  /**
   * Bumped by the tab's refresh control to re-list every server.
   *
   * There is no per-server refresh button any more — the rows carry their
   * origin instead of sitting under a header that could hold one — so this is
   * the only manual re-read, and it has to reach here.
   */
  refreshToken?: number;
  /** Renders a loaded skill in the right-hand viewer. */
  onOpenSkill?: (skill: VerifiedServerSkill, serverLabel: string) => void;
}

type ServerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; listing: ServerSkillListing }
  | { status: "error"; message: string };

export function ServerSkillsSection({
  servers,
  projectId,
  refreshToken,
  onOpenSkill,
}: Props) {
  /**
   * The hosted request context, as a version.
   *
   * `buildServerRequest` reads `clientCapabilities` from this context, and
   * whether THIS host declares `io.modelcontextprotocol/skills` is half of the
   * mutual declaration that decides `support.active`. The context hydrates
   * from a Convex query, so a listing issued on mount can go out before the
   * host config lands — advertising the SDK defaults, which deliberately omit
   * the skills extension. The answer then says `active: false` for a reason
   * that stopped being true a moment later, and nothing re-ran it.
   *
   * Same subscription `useAggregatedTools` uses, for the same reason: a
   * catalog is a fact about a NEGOTIATED CONNECTION, not about a server id.
   */
  const apiContextRevision = useSyncExternalStore(
    subscribeApiContext,
    getApiContextRevision,
    getApiContextRevision
  );
  const [byServer, setByServer] = useState<Record<string, ServerState>>({});
  const [uriInput, setUriInput] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<
    Record<string, ServerSkillRefusal | undefined>
  >({});
  const [opening, setOpening] = useState<Record<string, boolean>>({});
  /**
   * Server ids with a listing request in flight.
   *
   * The effect below reads `byServer` from its own render's closure, so two
   * passes before the `"loading"` write lands would both see `undefined` and
   * issue duplicate requests. A ref is observed synchronously and closes that
   * window without putting `byServer` in the dependency list (which would
   * re-run the effect on every state write it performs).
   */
  const inFlight = useRef<Set<string>>(new Set());

  const connected = useMemo(
    () => servers.filter((server) => server.connected),
    [servers]
  );

  /**
   * Bumped every time the connected set changes.
   *
   * Clearing `byServer` on a reconnect is not enough on its own: a listing
   * started before the reconnect resolves against the SAME `serverId` key, so
   * its write can land after the fresh one and restore exactly the stale
   * catalog the invalidation set out to discard. Stamping each load with the
   * generation it belongs to lets the late one recognise that it is answering
   * a connection that no longer exists.
   */
  const generation = useRef(0);

  const load = useCallback(
    async (serverId: string) => {
      const started = generation.current;
      inFlight.current.add(serverId);
      setByServer((prev) => ({ ...prev, [serverId]: { status: "loading" } }));
      try {
        const listing = await listServerSkills({
          serverId,
          ...(projectId ? { projectId } : {}),
        });
        if (started !== generation.current) return;
        setByServer((prev) => ({
          ...prev,
          [serverId]: { status: "ready", listing },
        }));
      } catch (error) {
        if (started !== generation.current) return;
        setByServer((prev) => ({
          ...prev,
          [serverId]: {
            status: "error",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        }));
      } finally {
        // Only if a NEWER load has not already claimed this key — clearing it
        // then would let the effect re-enter a fetch that is still running.
        if (started === generation.current) inFlight.current.delete(serverId);
      }
    },
    [projectId]
  );

  /**
   * Signature of the CONNECTED set. Reconnects are part of it, so a server
   * that dropped and came back re-fetches rather than showing the previous
   * connection's catalog — the catalog is a live fact about a connection, not
   * about a server id.
   */
  const connectedSignature = [
    connected.map((s) => s.serverId).join("|"),
    // A capability change re-negotiates the connection, so its previous answer
    // is about a handshake that no longer describes us.
    `rev:${apiContextRevision}`,
    `refresh:${refreshToken ?? 0}`,
  ].join("#");
  const seenSignature = useRef<string>("");

  useEffect(() => {
    // A changed connected-set means every entry is potentially stale: drop the
    // cache so reconnects and project switches re-read rather than reusing a
    // previous connection's answer.
    if (seenSignature.current !== connectedSignature) {
      seenSignature.current = connectedSignature;
      generation.current += 1;
      setByServer({});
      inFlight.current.clear();
      for (const server of connected) void load(server.serverId);
      return;
    }
    for (const server of connected) {
      if (
        byServer[server.serverId] === undefined &&
        !inFlight.current.has(server.serverId)
      ) {
        void load(server.serverId);
      }
    }
    // `byServer` is deliberately not a dependency: including it would re-run
    // this effect on every state write and re-enter the fetch it just started.
    // The `inFlight` ref covers the window that omission opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedSignature, connected, load]);

  /**
   * Synchronous in-flight lock, per server.
   *
   * `opening` is React state, so it does not update until the next render —
   * the Load button reads it and disables itself, but the URI input's Enter
   * handler can fire several times before that render lands, dispatching
   * duplicate concurrent loads. A ref is set before the first `await`, so it
   * closes the window for BOTH entry points rather than one.
   */
  const openInFlight = useRef<Set<string>>(new Set());

  const openSkill = useCallback(
    async (serverId: string, serverLabel: string, uri: string) => {
      if (openInFlight.current.has(serverId)) return;
      openInFlight.current.add(serverId);
      setRefusal((prev) => ({ ...prev, [serverId]: undefined }));
      setOpening((prev) => ({ ...prev, [serverId]: true }));
      try {
        const result = await getServerSkill({
          serverId,
          uri,
          ...(projectId ? { projectId } : {}),
        });
        if (!result.ok) {
          setRefusal((prev) => ({ ...prev, [serverId]: result.refusal }));
          return;
        }
        onOpenSkill?.(result.skill, serverLabel);
      } catch (error) {
        // An INTEGRITY failure comes back as `{ ok: false }`; a TRANSPORT
        // failure throws. Both need to reach the user — without this catch the
        // second becomes an unhandled rejection and the panel just does
        // nothing.
        setRefusal((prev) => ({
          ...prev,
          [serverId]: {
            kind: "fetch_failed",
            message: error instanceof Error ? error.message : "Unknown error",
            skillUri: uri,
          },
        }));
      } finally {
        openInFlight.current.delete(serverId);
        setOpening((prev) => ({ ...prev, [serverId]: false }));
      }
    },
    [onOpenSkill, projectId]
  );

  if (connected.length === 0) return null;

  return (
    <>
      {connected.map((server) => {
        const state = byServer[server.serverId] ?? { status: "idle" };
        const listing = state.status === "ready" ? state.listing : undefined;

        // A server that never declared the extension contributes nothing —
        // not an empty group. "This host and server never had a skills
        // conversation" is a different fact from "this server has no skills",
        // and a heading over nothing asserts the second.
        if (listing && !listing.support.active) {
          return null;
        }

        return (
          <div key={server.serverId}>
            {state.status === "error" && (
              <p className="text-[11px] text-destructive py-1 px-2">
                {server.label}: {state.message}
              </p>
            )}

            {listing?.skills.map((skill) => (
              <SkillRow
                key={skill.skillUri}
                skill={skill}
                origin={server.label}
                onOpen={() =>
                  void openSkill(server.serverId, server.label, skill.skillUri)
                }
              />
            ))}

            {listing && listing.skills.length === 0 && (
              <p className="text-[11px] text-muted-foreground py-1 px-2">
                {server.label} declares the skills extension but listed none. A
                listing may be partial — try loading a skill by URI.
              </p>
            )}

            {/* A duplicated URI is a server bug, surfaced rather than silently
                resolved by picking a winner. */}
            {listing && listing.duplicateUris.length > 0 && (
              <div className="flex items-start gap-1 py-1 px-2 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                <span>
                  {server.label} listed these more than once, so both copies
                  were rejected: {listing.duplicateUris.join(", ")}
                </span>
              </div>
            )}

            {listing?.rejected.map((entry) => (
              <div
                key={`${entry.skillUri}:${entry.reason}`}
                className="flex items-start gap-1 py-1 px-2 text-[11px] text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                <span>
                  {entry.skillUri || "(entry with no URI)"}: {entry.reason}
                </span>
              </div>
            ))}

            {/* Load by URI. Not a convenience: `skills/get` answers for skills
                a listing never mentioned, and a URI can arrive from a server's
                instructions or from another skill. Kept per server because the
                URI is only meaningful against the origin that serves it. */}
            {listing && (
              <div className="flex items-center gap-1 py-1 px-2">
                <Link2 className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                <input
                  value={uriInput[server.serverId] ?? ""}
                  aria-label={`Load a skill from ${server.label} by URI`}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    const uri = (uriInput[server.serverId] ?? "").trim();
                    if (!uri) return;
                    void openSkill(server.serverId, server.label, uri);
                  }}
                  onChange={(event) =>
                    setUriInput((prev) => ({
                      ...prev,
                      [server.serverId]: event.target.value,
                    }))
                  }
                  placeholder={`Load from ${server.label} by URI (skill://…)`}
                  className="flex-1 min-w-0 bg-transparent text-[11px] outline-none border-b border-transparent focus:border-border py-0.5"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    !(uriInput[server.serverId] ?? "").trim() ||
                    opening[server.serverId] === true
                  }
                  onClick={() =>
                    void openSkill(
                      server.serverId,
                      server.label,
                      (uriInput[server.serverId] ?? "").trim()
                    )
                  }
                >
                  Load
                </Button>
              </div>
            )}

            {refusal[server.serverId] && (
              <RefusalNotice refusal={refusal[server.serverId]!} />
            )}
          </div>
        );
      })}
    </>
  );
}

function SkillRow({
  skill,
  origin,
  onOpen,
}: {
  skill: ServerSkillSummary;
  /** The user-assigned label of the server serving this skill. */
  origin: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={skill.unloadable ? undefined : onOpen}
      disabled={Boolean(skill.unloadable)}
      title={skill.unloadable?.message ?? skill.skillUri}
      className="w-full text-left py-1 group disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {/* Origin, on the row rather than in a heading above a group. A
            skill's provenance travels with the skill: it is the reason its
            content is untrusted third-party input, and it stays true wherever
            the row is read. A heading only says it while you are under it. */}
        <Server
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="text-xs truncate group-hover:underline">
          {skill.name}
        </span>
        <Badge
          variant="secondary"
          className="text-[10px] flex-shrink-0 font-normal"
          title={`Served over MCP by ${origin}`}
        >
          {origin}
        </Badge>
        {skill.unloadable ? (
          <Badge
            variant="outline"
            className="text-[10px] flex-shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          >
            unverifiable — declined
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-[10px] flex-shrink-0 gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            title={`${skill.resources.length} file(s) in the advertised manifest`}
          >
            <ShieldCheck className="h-3 w-3" />
            {skill.resources.length}
          </Badge>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground truncate">
        {skill.description}
      </p>
    </button>
  );
}

/**
 * Renders a refusal with its specific violation.
 *
 * "Failed to load" would be useless here: the user is debugging a server, and
 * the difference between a digest mismatch, an unlisted file, and a drifted
 * frontmatter field is the entire diagnosis.
 */
function RefusalNotice({ refusal }: { refusal: ServerSkillRefusal }) {
  return (
    <div className="my-1 rounded border border-destructive/40 bg-destructive/5 p-2 text-[11px]">
      <div className="flex items-center gap-1 font-medium text-destructive">
        <AlertTriangle className="h-3 w-3" />
        {refusal.kind}
      </div>
      <p className="mt-1 text-muted-foreground">{refusal.message}</p>
      {refusal.field && (
        <p className="mt-1 font-mono">field: {refusal.field}</p>
      )}
      {refusal.resourceUri && (
        <p className="mt-1 font-mono break-all">file: {refusal.resourceUri}</p>
      )}
      {refusal.expected && (
        <p className="mt-1 font-mono break-all">expected: {refusal.expected}</p>
      )}
      {refusal.actual && (
        <p className="font-mono break-all">actual: {refusal.actual}</p>
      )}
    </div>
  );
}

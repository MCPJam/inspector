# GitHub-check network diagnostics

New GitHub-check sandboxes use the mirrored `egress-policy.ts` defaults and
override parser. `E2B_EGRESS_DENY_CIDRS` replaces the full list: unset uses RFC1918
defaults, empty disables denies with a warning, malformed values fail provisioning.
E2B rejection fails provisioning; there is no unrestricted retry. Keep the value
aligned with the Convex backend. Compare actual `denyOut` and `policySource` in
logs; `policyVersion` alone does not distinguish different overrides.

The backend manifest pins `convex/lib/egressPolicy.ts` against this module. Keep
both copies synchronized, including parser changes. Its trailing-comma style
matches the backend so the textual mirror check can compare the whole module.

## What is recorded

`provisionCheckSandbox` starts a Python 3 Linux packet-header observer before
returning the sandbox for clone/build. The dedicated template needs Python 3,
`sudo -n`, and permission to create an AF_PACKET socket. No pip package, agent
download, firewall change, credential environment, or checkout file is needed.

The observer uses a bounded packet prefix in memory. It emits only IP/transport
fields; it never writes packet files or sends payloads, DNS names, URL paths,
headers, credentials, or raw stderr to the logger. Server parsing copies an
allowlist of validated fields and discards everything else from guest JSON.

`[github-checks] network connection` fields:

| Field                                                    | Meaning                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `destinationIp`, `destinationPort`, `protocol`, `family` | Observed peer; TCP/UDP, IPv4/IPv6                                                             |
| `outcome`                                                | `attempted`, `syn_ack_observed`, `reset_observed`, `unreachable_observed`, `timeout_inferred` |
| `guestTimestamp`                                         | Guest wall clock, not trusted                                                                 |
| `observedAt`                                             | Server receipt time                                                                           |
| `sandboxId`, `triggerId`, `repoFullName`, `prNumber`     | Attached by the server, never accepted from guest JSON                                        |
| `policyVersion`, `policySource`, `denyOut`               | Policy supplied at creation, including any override                                           |
| `evidence`                                               | Always `guest_observed`                                                                       |

`triggerId` identifies the PR check before an eval-run row exists. Filter logs by
that ID or by repo/PR/sandbox when handling a user complaint. The effective policy
is also logged before provisioning and after creation.

`logger.info` / `logger.warn` use the existing Axiom dataset and its retention.
Records already shipped survive sandbox deletion. No new storage or retention
job is introduced. Shipping requires `AXIOM_TOKEN` and `AXIOM_DATASET` and respects
`DO_NOT_TRACK`; console messages alone do not preserve structured context. Verify
the worker's existing log destination during final deployment validation.

## Limits and failures

- Packet processing is capped at 2,000 packets/second to limit CPU use.
- Guest and server each allow 120 connection records/minute and 2,000/run.
- Pending TCP handshakes and recently established connections each have a
  512-entry cap. Inferred handshake timeout is 10 seconds; established tracking
  expires after five minutes. UDP records are attempts, not delivery receipts.
- Each line is at most 1,024 characters. Server parsing accepts at most 128 KiB
  per minute; it disconnects the command at 2 MiB total stdout or 4 KiB stderr
  because the E2B SDK also buffers output. One transport chunk may overshoot.
- Every 10 seconds, drop summaries include guest limits, kernel socket overflow,
  and server discards. Missing heartbeats, process/stream failures, startup
  timeout, and cleanup errors produce generic warnings without raw guest text.
- Startup waits at most five seconds; process kill waits at most two seconds.
  Monitor failure does not stop the check or modify its network policy.
  Sandbox cleanup still runs even when monitor cleanup fails.

These records are **diagnostics, not proof of a provider block**. E2B may reject
traffic outside the VM after a SYN-ACK; timeouts have several causes. Guest root
can disable or spoof the observer. Loopback is excluded; fragmented/truncated
headers and unsupported protocols may be missed. The monitor cannot see every
application error (for example, a TLS error or HTTP 500 after a successful TCP
connection). No outcome is named `blocked`.

## Live validation

Provide only the E2B key and deployed GitHub-check template ID, then run from
`mcpjam-inspector`:

```sh
NETWORK_SMOKE_REPORT=/tmp/network-smoke.json node --import tsx scripts/verify-network-diagnostics.ts
```

The smoke uses the real provisioning/monitor/cleanup path with synthetic HTTP
traffic. It captures logs locally, checks connection/reply records, host identity,
sentinel-header exclusion, monitor health, and provider-confirmed sandbox shutdown. It never contacts GitHub's write
APIs or runs customer code. The paired backend probe tests denial classification
and normal command/Git/package/API/MCP workloads under candidate policies.

Saved [live smoke result](./github-checks-network-smoke-2026-09-09.json).

On 2026-09-09 the real `mcpjam-github-checks` template started the monitor,
reported TCP/UDP attempts and SYN-ACK observations, and excluded the sentinel
header. The kernel-drop heartbeat remained healthy. Public IPv6 connectivity was
unverified; no IPv6 block is claimed. The backend probe also found that
`169.254.169.254` still answers HTTP 401 with a link-local deny, so that candidate
was not added to defaults. Responsive private/CGNAT fixtures remain outstanding.

Only new sandboxes receive this change. No UI, database migration, backfill, or
fork credential change. Final staging fork tests and production rollout are deferred.

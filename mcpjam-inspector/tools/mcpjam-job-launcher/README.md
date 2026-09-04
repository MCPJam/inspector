# mcpjam-job-launcher

Whole-tree cleanup for the local harness on Windows.

macOS and Linux get this from POSIX process groups: the supervisor puts each
root in its own group and signals the group. Windows has no equivalent —
`taskkill /T` walks a parent chain a re-parented process has already left — so
the supervisor spawns this launcher instead of the bridge, and it puts the
bridge in a Job Object with `KILL_ON_JOB_CLOSE`.

The ordering is the whole thing: **create suspended → assign to the job →
resume**. Assigning after the child has run leaves a window in which it may
already have spawned the vendor binary outside the job, which is precisely the
process this exists to contain.

It bounds LIFETIME, not authority. Every process in the job still runs as the
user. It exists so that "stop" means stop.

## Building

```bash
cd tools/mcpjam-job-launcher
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o mcpjam-job-launcher.exe .
```

CI builds it on `windows-latest` and ships it inside the Windows runtime pack,
where the pack's tree digest covers it like every other file — so the
supervisor will not launch a helper whose bytes changed.

## Why Windows is still refused

`nativePlatforms` does not list `win32`, and `supportsOwnershipProof('win32')`
answers false until a verified helper is present AND the conformance suite has
passed on `windows-latest`. An unenforced cleanup promise is worse than no
Windows support: a user who is told their session stopped, and whose 376 MB
agent is still running, has been lied to.

// mcpjam-job-launcher — whole-tree cleanup for the local harness on Windows.
//
// ── Why this exists ──────────────────────────────────────────────────────
// The supervisor's guarantee is that stopping a session stops everything it
// started. On macOS and Linux that is a POSIX process group: the supervisor
// puts each root in its own group, and signalling the group reaches every
// descendant whatever spawned it.
//
// Windows has no equivalent. `taskkill /T` walks a parent chain, which a
// re-parented process leaves; enumerating children races anything still
// spawning. What Windows does have is a Job Object: a kernel container that a
// process cannot leave, whose members die together when the last handle to it
// closes.
//
// So on Windows the supervisor spawns THIS instead of the bridge. It creates a
// job with KILL_ON_JOB_CLOSE, starts the bridge suspended, assigns it to the
// job before it can run — and therefore before it can spawn anything — then
// resumes it. Every descendant inherits the job. When this process exits, for
// any reason including being killed, the kernel closes the handle and takes the
// whole tree with it.
//
// ── Why the ordering matters ─────────────────────────────────────────────
// CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread is the whole
// point. Assigning after the child has run leaves a window in which it may
// already have spawned a grandchild outside the job, and that grandchild is
// exactly the 376 MB vendor binary this is here to contain.
//
// ── What it is not ───────────────────────────────────────────────────────
// It is not a sandbox and does not try to be. A job object bounds LIFETIME, not
// authority: every process in it still runs as the user, with the user's
// access. It exists so that "stop" means stop.
//
// Build (from this directory):
//
//	GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
//	  -o mcpjam-job-launcher.exe .
//
// Usage (the supervisor's spawn):
//
//	mcpjam-job-launcher.exe <exe> [args...]
package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: mcpjam-job-launcher <exe> [args...]")
		os.Exit(2)
	}
	os.Exit(run(os.Args[1], os.Args[2:]))
}

func run(exe string, args []string) int {
	// Who may be started, decided HERE.
	//
	// The supervisor resolves the child from the digest-verified runtime pack
	// (`bin/node.exe`, via `resolveNodeLauncher`) and refuses a relative path,
	// so today argv[1] is never a value a user or an MCP server chose. That is
	// a property of the caller, though, and this binary is the thing that
	// actually creates the process: a future caller threading a path in from a
	// config would turn the launcher into a general "start any program"
	// primitive without a line of it changing. So the invariant is restated
	// where it is enforceable — the child must be an absolute path inside the
	// same pack whose tree digest covers this launcher.
	//
	// It is not a privilege boundary; per the header, a job object bounds
	// lifetime and everything here runs as the user either way. It is a bound
	// on what this launcher can be repurposed to start.
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: os.Executable: %v\n", err)
		return 1
	}
	// Deliberately the checked path, not the argument: what StartProcess reads
	// below is exactly what was verified, rather than a name that could resolve
	// somewhere else by the time it is read.
	exe, err = childInsidePack(exe, self)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: %v\n", err)
		return 1
	}

	// The job is created first and never given a name: an unnamed job cannot be
	// opened by another process, so nothing outside this launcher can add a
	// process to it or, more importantly, remove one.
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: CreateJobObject: %v\n", err)
		return 1
	}
	defer windows.CloseHandle(job)

	// KILL_ON_JOB_CLOSE is the guarantee. When the last handle to this job
	// closes — this process exiting, however it exits — the kernel terminates
	// every process still in it. That covers the case a cleanup routine cannot:
	// this launcher being killed outright.
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: SetInformationJobObject: %v\n", err)
		return 1
	}

	// Stdio is inherited rather than piped. The supervisor already captures and
	// bounds the streams on its side; relaying them here would add a buffer
	// that can fill and a copy loop that can deadlock, for nothing.
	// The child's stdin is NUL, not this process's. Stdin here is the
	// supervisor's LIFELINE — a pipe it holds open and never writes to, whose
	// EOF means the supervisor is gone — and it belongs to this launcher
	// alone. Handed to the bridge as well, two readers block on one silent
	// pipe: the bridge never sees the EOF a `/dev/null` stdin gives it on
	// POSIX, and a bridge that reads stdin before it listens hangs until the
	// readiness timeout kills it, saying nothing.
	nul, err := os.OpenFile("NUL", os.O_RDONLY, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: open NUL: %v\n", err)
		return 1
	}
	defer nul.Close()

	attr := &syscall.ProcAttr{
		// Explicit, because this is the low-level `syscall.StartProcess`, not
		// `os.StartProcess`: here a nil Env is an EMPTY environment block, not
		// an inherited one. The child then starts with no SYSTEMROOT, and a
		// Node binary dies inside OpenSSL's random-number init before it runs
		// a line of JavaScript ("Assertion failed: ncrypto::CSPRNG"). The
		// supervisor built this environment for the child; pass it through.
		Env: os.Environ(),
		Files: []uintptr{
			nul.Fd(),
			os.Stdout.Fd(),
			os.Stderr.Fd(),
		},
		Sys: &syscall.SysProcAttr{
			// Suspended, so the assignment below happens before the child runs
			// a single instruction — and therefore before it can spawn anything
			// that would land outside the job.
			CreationFlags: windows.CREATE_SUSPENDED,
		},
	}
	pid, handle, err := syscall.StartProcess(exe, append([]string{exe}, args...), attr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: StartProcess: %v\n", err)
		return 1
	}
	childHandle := windows.Handle(handle)
	defer windows.CloseHandle(childHandle)

	if err := windows.AssignProcessToJobObject(job, childHandle); err != nil {
		// Assignment failed, so the child is NOT contained. Killing it is the
		// only correct answer: letting it resume would produce exactly the
		// uncontained tree this launcher exists to prevent, while the
		// supervisor believed otherwise.
		_ = windows.TerminateProcess(childHandle, 1)
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: AssignProcessToJobObject: %v\n", err)
		return 1
	}

	if err := resumeMainThread(uint32(pid)); err != nil {
		_ = windows.TerminateProcess(childHandle, 1)
		fmt.Fprintf(os.Stderr, "mcpjam-job-launcher: ResumeThread: %v\n", err)
		return 1
	}

	// Two ways the supervisor ends this: a signal, or closing stdin. Both just
	// return — the deferred CloseHandle is what kills the tree, so there is no
	// separate teardown path that could be skipped.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	stdinClosed := make(chan struct{})
	go func() {
		buf := make([]byte, 1)
		for {
			if _, err := os.Stdin.Read(buf); err != nil {
				close(stdinClosed)
				return
			}
		}
	}()
	exited := make(chan uint32, 1)
	go func() {
		_, _ = windows.WaitForSingleObject(childHandle, windows.INFINITE)
		var code uint32
		_ = windows.GetExitCodeProcess(childHandle, &code)
		exited <- code
	}()

	select {
	case code := <-exited:
		// The child's own exit code, so a caller reading it sees what the bridge
		// reported rather than what this wrapper felt like returning.
		return int(code)
	case <-signals:
		return 143 // 128 + SIGTERM, the conventional signalled-exit code.
	case <-stdinClosed:
		return 143
	}
}

// childInsidePack resolves the child executable and refuses one that is not
// inside this launcher's own runtime pack.
//
// `self` is this process's own image, and it is resolved BEFORE anything is
// derived from it. `os.Executable` is documented to return either the symlink
// that started the process or the file that symlink points at, depending on the
// platform, so deriving the root from the raw value lets a symlinked launcher
// authorize a child against a pack it does not actually live in: the derived
// root and the real one differ, and the check then answers the wrong question.
//
// In every distribution the launcher ships as
// `<pack>/bin/mcpjam-job-launcher.exe` and the child it is given is
// `<pack>/bin/node.exe`, so the pack root is two directories up and the child
// must be under it. The root rather than the `bin` directory alone, because
// what the digest covers — and therefore what consent named — is the tree.
//
// That `bin` is CHECKED rather than assumed, because the derivation is what
// defines the boundary: a launcher copied to `<somewhere>\anything\` would
// silently redefine `<somewhere>` as the pack, and a boundary the copier picks
// is not a boundary. A launcher outside the shipped layout has no pack to be
// inside of, so refusing is the only answer that does not widen the invariant
// this function exists to state.
//
// Both sides go through EvalSymlinks: the comparison is then between paths that
// exist, with `..` segments and links already collapsed, which is what makes it
// a containment check rather than a string trick.
func childInsidePack(exe string, self string) (string, error) {
	if !filepath.IsAbs(exe) {
		return "", fmt.Errorf(
			"refusing to start %q: the child must be an absolute path inside "+
				"the verified runtime pack, and a bare name would be resolved "+
				"through a mutable PATH at spawn time", exe,
		)
	}
	resolvedSelf, err := filepath.EvalSymlinks(self)
	if err != nil {
		return "", fmt.Errorf("resolving this launcher's own image: %w", err)
	}
	bin := filepath.Dir(resolvedSelf)
	if !strings.EqualFold(filepath.Base(bin), "bin") {
		return "", fmt.Errorf(
			"refusing to start %q: this launcher runs from %q, which is not the "+
				"`bin` directory of a runtime pack, so there is no pack root to "+
				"check the child against", exe, bin,
		)
	}
	root := filepath.Dir(bin)
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolving child %q: %w", exe, err)
	}
	if !withinRoot(root, resolved) {
		return "", fmt.Errorf(
			"refusing to start %q: it resolves to %q, which is outside this "+
				"launcher's runtime pack %q", exe, resolved, root,
		)
	}
	return resolved, nil
}

// withinRoot reports whether path is strictly below root. Both must already be
// resolved; equality is not containment, since the root is a directory and the
// child is a file inside it.
//
// `filepath.Rel` rather than a prefix comparison. Windows paths are
// case-insensitive, so the comparison has to fold case — but folding it over a
// slice of the prefix's BYTE length is wrong: a case pair whose two forms are
// different lengths in UTF-8 (`İ`/`i`, `K`/`k`) shifts every byte after it, the
// slice stops covering the same path elements, and a legitimate child inside
// the pack is refused. Rel folds case element by element and reports the way
// out, so `..` or a result starting with `..\` is the answer to "is this
// outside" with no string arithmetic at all; `.` is the root itself.
func withinRoot(root string, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	if err != nil {
		// Different volumes: no relative path exists, so neither does
		// containment.
		return false
	}
	if rel == "." || rel == ".." {
		return false
	}
	return !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resumeMainThread resumes the single thread of a CREATE_SUSPENDED process.
//
// A freshly created suspended process has exactly one thread, so the snapshot
// walk below finds one match. Enumerating rather than keeping the handle
// `StartProcess` opened is forced by the Go standard library, which does not
// return the thread handle.
func resumeMainThread(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ThreadEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return err
	}
	for {
		if entry.OwnerProcessID == pid {
			thread, err := windows.OpenThread(
				windows.THREAD_SUSPEND_RESUME,
				false,
				entry.ThreadID,
			)
			if err != nil {
				return err
			}
			_, err = windows.ResumeThread(thread)
			windows.CloseHandle(thread)
			return err
		}
		if err := windows.Thread32Next(snapshot, &entry); err != nil {
			// ERROR_NO_MORE_FILES ends the walk; anything else is a real error,
			// and either way we did not find the thread.
			return fmt.Errorf("no resumable thread for pid %d: %w", pid, err)
		}
	}
}

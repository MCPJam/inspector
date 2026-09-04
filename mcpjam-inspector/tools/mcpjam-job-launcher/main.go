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
	attr := &syscall.ProcAttr{
		// Explicit, because this is the low-level `syscall.StartProcess`, not
		// `os.StartProcess`: here a nil Env is an EMPTY environment block, not
		// an inherited one. The child then starts with no SYSTEMROOT, and a
		// Node binary dies inside OpenSSL's random-number init before it runs
		// a line of JavaScript ("Assertion failed: ncrypto::CSPRNG"). The
		// supervisor built this environment for the child; pass it through.
		Env: os.Environ(),
		Files: []uintptr{
			os.Stdin.Fd(),
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

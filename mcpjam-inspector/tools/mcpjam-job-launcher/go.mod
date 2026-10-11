module github.com/MCPJam/inspector/tools/mcpjam-job-launcher

go 1.26.0

require golang.org/x/sys v0.44.0

// x/sys v0.44.0 (CVE-2026-39824 fix) requires go >= 1.25, and go >= 1.23
// flips winsymlink to 1, changing how EvalSymlinks treats the junctions that
// link launchers into packs. Pin the pre-1.23 behavior the shipped launcher
// has always had (the old go directive was 1.22).
godebug winsymlink=0

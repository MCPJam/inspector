package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// packLayout builds the shape the launcher actually ships in — a pack root
// with a `bin` directory holding the launcher and the pack's own Node — and
// returns the launcher's path and the pack root.
func packLayout(t *testing.T) (self string, root string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks(TempDir): %v", err)
	}
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	self = filepath.Join(bin, "mcpjam-job-launcher.exe")
	for _, name := range []string{self, filepath.Join(bin, "node.exe")} {
		if err := os.WriteFile(name, []byte("stub"), 0o755); err != nil {
			t.Fatalf("WriteFile %s: %v", name, err)
		}
	}
	return self, root
}

func TestChildInsidePackAcceptsThePacksOwnNode(t *testing.T) {
	self, root := packLayout(t)
	node := filepath.Join(root, "bin", "node.exe")

	got, err := childInsidePack(node, self)
	if err != nil {
		t.Fatalf("childInsidePack(%q) = error %v, want the resolved path", node, err)
	}
	if got != node {
		t.Fatalf("childInsidePack(%q) = %q, want %q", node, got, node)
	}
}

// The pack root, not the `bin` directory, is the boundary: the tree digest
// covers the whole pack, so a sibling of `bin` is inside the consent.
func TestChildInsidePackAcceptsElsewhereInTheTree(t *testing.T) {
	self, root := packLayout(t)
	nested := filepath.Join(root, "vendor", "tool.exe")
	if err := os.MkdirAll(filepath.Dir(nested), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(nested, []byte("stub"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, err := childInsidePack(nested, self); err != nil {
		t.Fatalf("childInsidePack(%q) = error %v, want acceptance", nested, err)
	}
}

// Windows paths are case-insensitive, so folding case is correctness, not
// leniency: this is the same file as the accepted case above.
func TestChildInsidePackFoldsCase(t *testing.T) {
	self, root := packLayout(t)
	shouted := filepath.Join(strings.ToUpper(filepath.Join(root, "bin")), "NODE.EXE")

	if _, err := childInsidePack(shouted, self); err != nil {
		t.Fatalf("childInsidePack(%q) = error %v, want acceptance", shouted, err)
	}
}

// The finding this check answers: an absolute path to a program of someone
// else's choosing must not be startable inside our job object.
func TestChildInsidePackRejectsOutsideTheTree(t *testing.T) {
	self, _ := packLayout(t)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks(TempDir): %v", err)
	}
	attacker := filepath.Join(outside, "payload.exe")
	if err := os.WriteFile(attacker, []byte("stub"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, err := childInsidePack(attacker, self); err == nil {
		t.Fatalf("childInsidePack(%q) accepted a path outside the pack", attacker)
	}
}

// `..` is collapsed before the comparison, so climbing out of the pack and
// back down into it is not a way in.
func TestChildInsidePackRejectsTraversalOutOfTheTree(t *testing.T) {
	self, root := packLayout(t)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks(TempDir): %v", err)
	}
	attacker := filepath.Join(outside, "payload.exe")
	if err := os.WriteFile(attacker, []byte("stub"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	traversal := filepath.Join(root, "bin", "..", "..",
		filepath.Base(outside), "payload.exe")

	if _, err := childInsidePack(traversal, self); err == nil {
		t.Fatalf("childInsidePack(%q) accepted a traversal out of the pack", traversal)
	}
}

func TestChildInsidePackRejectsRelativePath(t *testing.T) {
	self, _ := packLayout(t)

	if _, err := childInsidePack("node.exe", self); err == nil {
		t.Fatal("childInsidePack(\"node.exe\") accepted a bare name, which " +
			"would be resolved through PATH at spawn time")
	}
}

func TestChildInsidePackRejectsMissingChild(t *testing.T) {
	self, root := packLayout(t)
	absent := filepath.Join(root, "bin", "not-installed.exe")

	if _, err := childInsidePack(absent, self); err == nil {
		t.Fatalf("childInsidePack(%q) accepted a path with no file behind it", absent)
	}
}

// The pack root itself is not a child, and neither is a directory whose name
// merely starts with the root's.
//
// Written as literals rather than `filepath.Join("C:", ...)`: Go treats a bare
// `C:` as a drive-RELATIVE root, so joining it yields `C:packs\claude-code` —
// a path relative to whatever the process's current directory on C: happens to
// be. The assertions would then be about the wrong shape of path entirely.
func TestWithinRootRejectsTheRootAndNamePrefixes(t *testing.T) {
	root := `C:\packs\claude-code`

	if withinRoot(root, root) {
		t.Fatal("withinRoot reported the root as being inside itself")
	}
	sibling := `C:\packs\claude-code-evil\node.exe`
	if withinRoot(root, sibling) {
		t.Fatalf("withinRoot accepted %q, which only shares a name prefix", sibling)
	}
}

// A case pair whose two forms are different lengths in UTF-8. Folding case over
// a byte slice of the prefix's length mismatches here and refuses a child that
// is genuinely inside the pack.
func TestWithinRootFoldsCaseAcrossWidthChangingPairs(t *testing.T) {
	root := `C:\packs\Kelvin`
	child := `C:\packs\` + "\u212A" + `elvin\bin\node.exe`

	if !withinRoot(root, child) {
		t.Fatalf("withinRoot rejected %q, which is inside %q", child, root)
	}
}

// A launcher outside `<pack>/bin` has no pack root to derive, and deriving one
// anyway would let whoever copied the binary choose the boundary.
func TestChildInsidePackRejectsALauncherOutsideBin(t *testing.T) {
	_, root := packLayout(t)
	stray := filepath.Join(root, "tools", "mcpjam-job-launcher.exe")
	if err := os.MkdirAll(filepath.Dir(stray), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(stray, []byte("stub"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	node := filepath.Join(root, "bin", "node.exe")

	if _, err := childInsidePack(node, stray); err == nil {
		t.Fatalf("childInsidePack accepted a launcher at %q, outside any pack's bin", stray)
	}
}

// symlinkOrSkip creates a symlink, skipping the test when the runner lacks the
// privilege Windows requires for one. Skipping rather than failing, because the
// behaviour under test is the launcher's, not the runner's account rights.
func symlinkOrSkip(t *testing.T, target string, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create a symlink on this runner: %v", err)
	}
}

// `os.Executable` may hand back the symlink that started the process rather
// than the file behind it. Resolving it first is what makes the derived root
// the pack the launcher actually lives in.
func TestChildInsidePackResolvesASymlinkedLauncher(t *testing.T) {
	_, root := packLayout(t)
	linkedBin := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(linkedBin, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	// The launcher as the supervisor would see it: a link in a directory that
	// is not inside the pack, pointing at the pack's real launcher.
	link := filepath.Join(linkedBin, "mcpjam-job-launcher.exe")
	symlinkOrSkip(t, filepath.Join(root, "bin", "mcpjam-job-launcher.exe"), link)
	node := filepath.Join(root, "bin", "node.exe")

	got, err := childInsidePack(node, link)
	if err != nil {
		t.Fatalf("childInsidePack(%q, %q) = error %v, want the resolved path", node, link, err)
	}
	if got != node {
		t.Fatalf("childInsidePack(%q, %q) = %q, want %q", node, link, got, node)
	}
}

// The case the doc comment claims collapsing links buys: a link that lives
// inside the pack, so every prefix comparison passes, but whose target does
// not. Without EvalSymlinks on the child this is the way past the check.
func TestChildInsidePackRejectsALinkInsideThePackPointingOut(t *testing.T) {
	self, root := packLayout(t)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks(TempDir): %v", err)
	}
	attacker := filepath.Join(outside, "payload.exe")
	if err := os.WriteFile(attacker, []byte("stub"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	link := filepath.Join(root, "bin", "node-shim.exe")
	symlinkOrSkip(t, attacker, link)

	if _, err := childInsidePack(link, self); err == nil {
		t.Fatalf("childInsidePack(%q) accepted a link inside the pack whose target is %q",
			link, attacker)
	}
}

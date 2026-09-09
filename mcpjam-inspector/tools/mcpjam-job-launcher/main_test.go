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
func TestWithinRootRejectsTheRootAndNamePrefixes(t *testing.T) {
	root := filepath.Join("C:", "packs", "claude-code")

	if withinRoot(root, root) {
		t.Fatal("withinRoot reported the root as being inside itself")
	}
	sibling := filepath.Join("C:", "packs", "claude-code-evil", "node.exe")
	if withinRoot(root, sibling) {
		t.Fatalf("withinRoot accepted %q, which only shares a name prefix", sibling)
	}
}

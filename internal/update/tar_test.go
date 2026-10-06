package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// targz writes a .tar.gz holding the given entries, in order.
func targz(t *testing.T, entries map[string][]byte, order ...string) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, name := range order {
		body := entries[name]
		hdr := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if strings.HasSuffix(name, "/") {
			hdr.Typeflag = tar.TypeDir
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			if _, err := tw.Write(body); err != nil {
				t.Fatal(err)
			}
		}
	}
	tw.Close()
	gz.Close()
	path := filepath.Join(t.TempDir(), "asset.tar.gz")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestUntarBinaryTakesTheFirstRegularFile(t *testing.T) {
	archive := targz(t, map[string][]byte{"pginspect-linux-amd64/": nil, "pginspect-linux-amd64/pginspect": []byte("#!/bin/sh\necho hi\n"), "README": []byte("later")},
		"pginspect-linux-amd64/", "pginspect-linux-amd64/pginspect", "README")
	dir := t.TempDir()
	got, err := untarBinary(archive, dir)
	if err != nil {
		t.Fatal(err)
	}
	// Flattened to the base name, executable, and only the first file.
	if got != filepath.Join(dir, "pginspect") {
		t.Errorf("extracted to %s", got)
	}
	fi, err := os.Stat(got)
	if err != nil || fi.Mode().Perm()&0o100 == 0 {
		t.Errorf("binary not executable: %v %v", fi, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "README")); err == nil {
		t.Error("a later entry was extracted too")
	}
}

func TestUntarBinaryRejectsEmptyArchive(t *testing.T) {
	archive := targz(t, map[string][]byte{"only-a-dir/": nil}, "only-a-dir/")
	if _, err := untarBinary(archive, t.TempDir()); err == nil || !strings.Contains(err.Error(), "no file") {
		t.Errorf("err = %v, want 'archive holds no file'", err)
	}
	if _, err := untarBinary(filepath.Join(t.TempDir(), "missing.tar.gz"), t.TempDir()); err == nil {
		t.Error("a missing archive did not fail")
	}
}

// TestExtractionIsBounded: a tar of zeros compresses to almost nothing, so an
// archive can be tiny on the wire and enormous on disk. The cap has to stop
// it, for both the tarball and the zip bundle paths.
func TestExtractionIsBounded(t *testing.T) {
	big := make([]byte, maxExtractBytes+1)
	archive := targz(t, map[string][]byte{"pginspect": big}, "pginspect")
	if _, err := untarBinary(archive, t.TempDir()); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Errorf("tar: err = %v, want the size cap", err)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("pginspect.app/Contents/MacOS/pginspect")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(big); err != nil {
		t.Fatal(err)
	}
	zw.Close()
	zpath := filepath.Join(t.TempDir(), "asset.zip")
	if err := os.WriteFile(zpath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := unzipBundle(zpath, t.TempDir()); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Errorf("zip: err = %v, want the size cap", err)
	}
}

func TestCopyBoundedAllowsTheLimitExactly(t *testing.T) {
	var out bytes.Buffer
	if err := copyBounded(&out, bytes.NewReader(make([]byte, maxExtractBytes))); err != nil {
		t.Errorf("exactly the limit was refused: %v", err)
	}
	if out.Len() != maxExtractBytes {
		t.Errorf("copied %d bytes", out.Len())
	}
}

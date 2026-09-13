package update

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		tag, cur string
		want     bool
	}{
		{"v0.2.0", "v0.1.0", true}, {"v0.1.0", "v0.1.0", false}, {"v0.1.0", "v0.2.0", false},
		{"v1.0.0", "v0.9.9", true}, {"v0.1.10", "v0.1.9", true}, {"v0.1.0", "v0.1.0-rc1", true},
		{"v0.1.0-rc2", "v0.1.0-rc1", false}, {"v0.2.0", "dev-abc123", false}, {"nonsense", "v0.1.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.tag, c.cur); got != c.want {
			t.Errorf("Newer(%q, %q) = %v", c.tag, c.cur, got)
		}
	}
	if Supported("dev-1234567") || !Supported("v0.1.0") {
		t.Error("Supported")
	}
}

func TestAssetName(t *testing.T) {
	if AssetName("darwin", "arm64") != "pginspect-darwin-universal.zip" || AssetName("windows", "amd64") != "pginspect-windows-amd64.exe" || AssetName("linux", "amd64") != "pginspect-linux-amd64.tar.gz" {
		t.Error("asset names drifted from the release workflow")
	}
}

func TestVerify(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	file := filepath.Join(dir, "pginspect-linux-amd64.tar.gz")
	os.WriteFile(file, []byte("binary bytes"), 0o644)
	sum := sha256.Sum256([]byte("binary bytes"))
	sums := []byte("deadbeef  other\n" + hex.EncodeToString(sum[:]) + "  pginspect-linux-amd64.tar.gz\n")
	sig := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sums)) + "\n")
	key := base64.StdEncoding.EncodeToString(pub)
	if err := Verify(sums, sig, key, "pginspect-linux-amd64.tar.gz", file); err != nil {
		t.Fatalf("valid update refused: %v", err)
	}
	// Tampered checksums file.
	if err := Verify(append([]byte("x"), sums...), sig, key, "pginspect-linux-amd64.tar.gz", file); err == nil {
		t.Error("tampered checksums accepted")
	}
	// Wrong key.
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if err := Verify(sums, sig, base64.StdEncoding.EncodeToString(otherPub), "pginspect-linux-amd64.tar.gz", file); err == nil {
		t.Error("foreign signature accepted")
	}
	// Tampered download.
	os.WriteFile(file, []byte("evil bytes"), 0o644)
	if err := Verify(sums, sig, key, "pginspect-linux-amd64.tar.gz", file); err == nil {
		t.Error("mismatching file accepted")
	}
	// The embedded key must be a valid key.
	if k, err := base64.StdEncoding.DecodeString(ReleasePublicKey); err != nil || len(k) != ed25519.PublicKeySize {
		t.Error("embedded release key is malformed")
	}
}

func TestReplaceBinary(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "pginspect")
	os.WriteFile(target, []byte("old"), 0o755)
	newBin := filepath.Join(dir, "pginspect-new")
	os.WriteFile(newBin, []byte("new"), 0o644)
	if err := install(newBin, target); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(target)
	old, _ := os.ReadFile(target + ".old")
	if string(got) != "new" || string(old) != "old" {
		t.Errorf("target=%q old=%q", got, old)
	}
	if fi, _ := os.Stat(target); runtime.GOOS != "windows" && fi.Mode().Perm()&0o111 == 0 {
		t.Error("installed binary not executable")
	}
}

func TestInstallBundle(t *testing.T) {
	dir := t.TempDir()
	// Current "bundle".
	target := filepath.Join(dir, "pginspect.app")
	os.MkdirAll(filepath.Join(target, "Contents", "MacOS"), 0o755)
	os.WriteFile(filepath.Join(target, "Contents", "MacOS", "pginspect"), []byte("old"), 0o755)
	// A zip of the new bundle, the way ditto -c -k --keepParent lays it out.
	zipPath := filepath.Join(dir, "pginspect-darwin-universal.zip")
	zf, _ := os.Create(zipPath)
	zw := zip.NewWriter(zf)
	for _, e := range []struct {
		name string
		body string
		mode os.FileMode
	}{
		{"pginspect.app/Contents/Info.plist", "<plist/>", 0o644},
		{"pginspect.app/Contents/MacOS/pginspect", "new", 0o755},
	} {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		h.SetMode(e.mode)
		w, _ := zw.CreateHeader(h)
		w.Write([]byte(e.body))
	}
	zw.Close()
	zf.Close()
	if err := install(zipPath, target); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(target, "Contents", "MacOS", "pginspect"))
	if string(got) != "new" {
		t.Errorf("bundle not replaced: %q", got)
	}
	if _, err := os.Stat(filepath.Join(target+".old", "Contents", "MacOS", "pginspect")); err != nil {
		t.Error("old bundle not kept beside the new one")
	}
	if fi, _ := os.Stat(filepath.Join(target, "Contents", "MacOS", "pginspect")); fi.Mode().Perm()&0o111 == 0 {
		t.Error("executable bit lost in extraction")
	}
}

// TestCheckLive talks to GitHub; run with PGINSPECT_UPDATE_LIVE=1.
func TestCheckLive(t *testing.T) {
	if os.Getenv("PGINSPECT_UPDATE_LIVE") == "" {
		t.Skip("set PGINSPECT_UPDATE_LIVE=1 to query GitHub")
	}
	u := New("daniel-widrick/pginspect", "v0.0.1", t.TempDir())
	st, err := u.Check(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("state=%s available=%+v", st.State, st.Available)
	if st.State == "available" {
		rel := st.Available
		if rel.Asset.URL == "" || rel.Checksums == "" || rel.Signature == "" {
			t.Errorf("incomplete release: %+v", rel)
		}
		dir := t.TempDir()
		file := filepath.Join(dir, rel.Asset.Name)
		if err := u.download(context.Background(), rel.Asset.URL, file, rel.Asset.Size); err != nil {
			t.Fatal(err)
		}
		sums, _ := u.fetch(context.Background(), rel.Checksums)
		sig, _ := u.fetch(context.Background(), rel.Signature)
		if err := Verify(sums, sig, u.PublicKey, rel.Asset.Name, file); err != nil {
			t.Fatalf("real release failed verification: %v", err)
		}
	}
}

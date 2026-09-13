// Package update checks GitHub releases for a newer pginspect, verifies a
// downloaded build against the signed checksums file, and swaps it into
// place. It is deliberately simple: one channel, weekly checks, update on
// click, relaunch afterwards.
package update

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CheckInterval is how often the background check runs.
const CheckInterval = 7 * 24 * time.Hour

// Asset is one downloadable release file.
type Asset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// Release is a newer version that can be installed.
type Release struct {
	Tag        string    `json:"tag"`
	Notes      string    `json:"notes"`
	URL        string    `json:"url"`
	Published  time.Time `json:"published"`
	Prerelease bool      `json:"prerelease"`
	Asset      Asset     `json:"asset"`
	Checksums  string    `json:"checksums"`
	Signature  string    `json:"signature"`
}

// Status is what the UI shows.
type Status struct {
	Current string `json:"current"`
	// State is idle, checking, up-to-date, available, downloading, verifying,
	// installing, restarting, unsupported or error.
	State     string    `json:"state"`
	Available *Release  `json:"available,omitempty"`
	Error     string    `json:"error,omitempty"`
	Progress  float64   `json:"progress"`
	LastCheck time.Time `json:"lastCheck"`
	Skipped   string    `json:"skipped,omitempty"`
}

type persisted struct {
	LastCheck time.Time `json:"lastCheck"`
	Skipped   string    `json:"skipped"`
}

// Updater holds the state for one running app.
type Updater struct {
	Repo      string
	Current   string
	PublicKey string
	Client    *http.Client
	// OnChange is called after every status change.
	OnChange func(Status)

	stateFile string
	mu        sync.Mutex
	status    Status
}

// New creates an updater for github.com/<repo> at the running version, with
// last-check and skip state stored under stateDir.
func New(repo, current, stateDir string) *Updater {
	u := &Updater{Repo: repo, Current: current, PublicKey: ReleasePublicKey, Client: &http.Client{Timeout: 5 * time.Minute}}
	if stateDir != "" {
		u.stateFile = filepath.Join(stateDir, "update.json")
	}
	u.status = Status{Current: current, State: "idle"}
	if data, err := os.ReadFile(u.stateFile); err == nil {
		var p persisted
		if json.Unmarshal(data, &p) == nil {
			u.status.LastCheck = p.LastCheck
			u.status.Skipped = p.Skipped
		}
	}
	if !Supported(current) {
		u.status.State = "unsupported"
	}
	return u
}

// Supported reports whether a build can update itself: it must carry a
// release version, not a dev stamp.
func Supported(current string) bool {
	_, ok := parseVersion(current)
	return ok
}

// Status returns a copy of the current state.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.status
}

func (u *Updater) set(f func(*Status)) Status {
	u.mu.Lock()
	f(&u.status)
	st := u.status
	u.mu.Unlock()
	if u.OnChange != nil {
		u.OnChange(st)
	}
	return st
}

func (u *Updater) save() {
	if u.stateFile == "" {
		return
	}
	u.mu.Lock()
	p := persisted{LastCheck: u.status.LastCheck, Skipped: u.status.Skipped}
	u.mu.Unlock()
	if data, err := json.Marshal(p); err == nil {
		_ = os.WriteFile(u.stateFile, data, 0o600)
	}
}

// Due reports whether the weekly check should run now.
func (u *Updater) Due() bool {
	st := u.Status()
	return st.State != "unsupported" && time.Since(st.LastCheck) > CheckInterval
}

// Skip hides the given version until a newer one appears.
func (u *Updater) Skip(tag string) {
	u.set(func(s *Status) {
		s.Skipped = tag
		if s.Available != nil && s.Available.Tag == tag {
			s.Available = nil
			s.State = "up-to-date"
		}
	})
	u.save()
}

type ghRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	Body        string `json:"body"`
	HTMLURL     string `json:"html_url"`
	Prerelease  bool   `json:"prerelease"`
	Draft       bool   `json:"draft"`
	PublishedAt string `json:"published_at"`
	Assets      []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

// Check asks GitHub for the latest release. With force, a skipped version
// is offered again.
func (u *Updater) Check(ctx context.Context, force bool) (Status, error) {
	if !Supported(u.Current) {
		return u.Status(), nil
	}
	u.set(func(s *Status) { s.State = "checking"; s.Error = "" })
	rel, err := u.latest(ctx)
	now := time.Now()
	if err != nil {
		st := u.set(func(s *Status) { s.State = "error"; s.Error = err.Error(); s.LastCheck = now })
		u.save()
		return st, err
	}
	st := u.set(func(s *Status) {
		s.LastCheck = now
		switch {
		case rel == nil:
			s.State = "up-to-date"
			s.Available = nil
		case !force && s.Skipped == rel.Tag:
			s.State = "up-to-date"
			s.Available = nil
		default:
			s.State = "available"
			s.Available = rel
			if force {
				s.Skipped = ""
			}
		}
	})
	u.save()
	return st, nil
}

// latest returns the newest release that is newer than the running version,
// or nil when up to date.
func (u *Updater) latest(ctx context.Context) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+u.Repo+"/releases/latest", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "pginspect/"+u.Current)
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil // no releases yet
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub returned %s", resp.Status)
	}
	var gr ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&gr); err != nil {
		return nil, err
	}
	if gr.Draft {
		return nil, nil
	}
	if !Newer(gr.TagName, u.Current) {
		return nil, nil
	}
	rel := &Release{Tag: gr.TagName, Notes: gr.Body, URL: gr.HTMLURL, Prerelease: gr.Prerelease}
	rel.Published, _ = time.Parse(time.RFC3339, gr.PublishedAt)
	want := AssetName(runtime.GOOS, runtime.GOARCH)
	for _, a := range gr.Assets {
		switch a.Name {
		case want:
			rel.Asset = Asset{Name: a.Name, URL: a.URL, Size: a.Size}
		case "checksums.txt":
			rel.Checksums = a.URL
		case "checksums.txt.sig":
			rel.Signature = a.URL
		}
	}
	if rel.Asset.URL == "" {
		return nil, fmt.Errorf("release %s has no build for %s/%s", gr.TagName, runtime.GOOS, runtime.GOARCH)
	}
	if rel.Checksums == "" || rel.Signature == "" {
		return nil, fmt.Errorf("release %s is not signed", gr.TagName)
	}
	return rel, nil
}

// AssetName is the release file for a platform, matching the release workflow.
func AssetName(goos, goarch string) string {
	switch goos {
	case "darwin":
		return "pginspect-darwin-universal.zip"
	case "windows":
		return "pginspect-windows-" + goarch + ".exe"
	default:
		return "pginspect-linux-" + goarch + ".tar.gz"
	}
}

// Apply downloads the available release, verifies it, installs it over the
// running program and starts the new version. The caller should quit once
// it returns without error.
func (u *Updater) Apply(ctx context.Context) error {
	st := u.Status()
	if st.Available == nil {
		return errors.New("no update available")
	}
	rel := *st.Available
	fail := func(err error) error {
		u.set(func(s *Status) { s.State = "error"; s.Error = err.Error() })
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	target := installTarget(exe)
	if err := writable(target); err != nil {
		return fail(fmt.Errorf("cannot replace %s: %w. Download the new version from %s", target, err, rel.URL))
	}

	u.set(func(s *Status) { s.State = "downloading"; s.Progress = 0 })
	work, err := os.MkdirTemp(filepath.Dir(target), ".pginspect-update-")
	if err != nil {
		return fail(err)
	}
	defer os.RemoveAll(work)
	file := filepath.Join(work, rel.Asset.Name)
	if err := u.download(ctx, rel.Asset.URL, file, rel.Asset.Size); err != nil {
		return fail(err)
	}

	u.set(func(s *Status) { s.State = "verifying" })
	sums, err := u.fetch(ctx, rel.Checksums)
	if err != nil {
		return fail(err)
	}
	sig, err := u.fetch(ctx, rel.Signature)
	if err != nil {
		return fail(err)
	}
	if err := Verify(sums, sig, u.PublicKey, rel.Asset.Name, file); err != nil {
		return fail(err)
	}

	u.set(func(s *Status) { s.State = "installing" })
	if err := install(file, target); err != nil {
		return fail(err)
	}
	u.set(func(s *Status) { s.State = "restarting" })
	if err := relaunch(target); err != nil {
		return fail(fmt.Errorf("installed, but could not restart: %w. Start pginspect again by hand", err))
	}
	return nil
}

func (u *Updater) fetch(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "pginspect/"+u.Current)
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

func (u *Updater) download(ctx context.Context, url, dest string, size int64) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "pginspect/"+u.Current)
	resp, err := u.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download: %s", resp.Status)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	var done int64
	buf := make([]byte, 256<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				return err
			}
			done += int64(n)
			if size > 0 {
				p := float64(done) / float64(size)
				u.set(func(s *Status) { s.Progress = p })
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// Verify checks the signature over the checksums file with the release
// public key, then checks the file's SHA-256 against the entry for name.
func Verify(checksums, signature []byte, publicKey, name, path string) error {
	pub, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return errors.New("bad release public key")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errors.New("bad checksums signature")
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), checksums, sig) {
		return errors.New("checksums file is not signed with the pginspect release key; refusing the update")
	}
	var want string
	for _, line := range strings.Split(string(checksums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			want = fields[0]
		}
	}
	if want == "" {
		return fmt.Errorf("checksums file has no entry for %s", name)
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("downloaded file does not match its checksum")
	}
	return nil
}

// installTarget is what gets replaced: the .app bundle on macOS, the
// executable elsewhere.
func installTarget(exe string) string {
	if runtime.GOOS == "darwin" {
		// .../pginspect.app/Contents/MacOS/pginspect
		if bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe))); strings.HasSuffix(bundle, ".app") {
			return bundle
		}
	}
	return exe
}

func writable(target string) error {
	dir := filepath.Dir(target)
	probe, err := os.CreateTemp(dir, ".pginspect-probe-")
	if err != nil {
		return fmt.Errorf("%s is not writable", dir)
	}
	probe.Close()
	os.Remove(probe.Name())
	return nil
}

// install puts the downloaded file in place of target, keeping the old
// version beside it as <target>.old until the next start cleans it up.
func install(file, target string) error {
	old := target + ".old"
	_ = os.RemoveAll(old)
	// Extract into a fresh directory so nothing can land on the target's
	// own path before the swap.
	scratch, err := os.MkdirTemp(filepath.Dir(file), "extract-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(scratch)
	switch {
	case strings.HasSuffix(file, ".zip"):
		extracted, err := unzipBundle(file, scratch)
		if err != nil {
			return err
		}
		if err := os.Rename(target, old); err != nil {
			return err
		}
		if err := os.Rename(extracted, target); err != nil {
			_ = os.Rename(old, target)
			return err
		}
	case strings.HasSuffix(file, ".tar.gz"):
		bin, err := untarBinary(file, scratch)
		if err != nil {
			return err
		}
		return replaceBinary(bin, target, old)
	default:
		return replaceBinary(file, target, old)
	}
	return nil
}

func replaceBinary(newBin, target, old string) error {
	if err := os.Rename(target, old); err != nil {
		return err
	}
	if err := os.Rename(newBin, target); err != nil {
		// Different volume: copy instead.
		if cerr := copyFile(newBin, target); cerr != nil {
			_ = os.Rename(old, target)
			return cerr
		}
	}
	return os.Chmod(target, 0o755)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// unzipBundle extracts a zip into dir and returns the path of the .app
// bundle inside it, preserving file modes.
func unzipBundle(path, dir string) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer zr.Close()
	bundle := ""
	for _, f := range zr.File {
		name := filepath.Clean(f.Name)
		if strings.HasPrefix(name, "..") {
			return "", fmt.Errorf("zip entry escapes directory: %s", f.Name)
		}
		dest := filepath.Join(dir, name)
		if bundle == "" {
			if i := strings.Index(name, ".app"); i >= 0 {
				bundle = filepath.Join(dir, name[:i+4])
			}
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return "", err
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		mode := f.Mode().Perm()
		if mode == 0 {
			mode = 0o644
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			rc.Close()
			return "", err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return "", err
		}
	}
	if bundle == "" {
		return "", errors.New("no .app bundle in the downloaded archive")
	}
	return bundle, nil
}

// relaunch starts the installed version. On macOS the bundle is opened as a
// new instance; elsewhere the executable is started with the same arguments.
func relaunch(target string) error {
	if runtime.GOOS == "darwin" && strings.HasSuffix(target, ".app") {
		return exec.Command("open", "-n", target).Start()
	}
	cmd := exec.Command(target, os.Args[1:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Start()
}

// Cleanup removes the previous version left beside the program by the last
// update. Call it at startup.
func Cleanup() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	exe, _ = filepath.EvalSymlinks(exe)
	_ = os.RemoveAll(installTarget(exe) + ".old")
}

// parseVersion reads v1.2.3 or 1.2.3 with an optional -prerelease suffix.
func parseVersion(v string) ([3]int, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

// Newer reports whether tag is a higher release version than current.
func Newer(tag, current string) bool {
	a, ok := parseVersion(tag)
	if !ok {
		return false
	}
	b, ok := parseVersion(current)
	if !ok {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	// Same numbers: a release beats a pre-release of it.
	return strings.Contains(current, "-") && !strings.Contains(strings.TrimPrefix(tag, "v"), "-")
}

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// openTestStore points the platform config directory at a temporary home and
// keeps passwords in the file store, so nothing touches the real keychain.
func openTestStore(t *testing.T) *Store {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("AppData", home)
	t.Setenv("PGINSPECT_NO_KEYRING", "1")
	s, err := Open()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return s
}

func TestSaveFillsDefaultsAndRoundTrips(t *testing.T) {
	s := openTestStore(t)
	if len(s.List()) != 0 {
		t.Fatal("a fresh store is not empty")
	}

	p, err := s.Save(Profile{Name: "prod", Host: "db.example.net", Database: "app", User: "reader"})
	if err != nil {
		t.Fatal(err)
	}
	if p.ID == "" || p.Port != 5432 || p.SSLMode != "prefer" {
		t.Errorf("defaults not applied: %+v", p)
	}
	if _, err := s.Save(Profile{Name: "local", Host: "localhost", Port: 5433, SSLMode: "disable"}); err != nil {
		t.Fatal(err)
	}

	// A second Open reads what the first wrote, sorted by name.
	again, err := Open()
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, q := range again.List() {
		names = append(names, q.Name)
	}
	if strings.Join(names, ",") != "local,prod" {
		t.Errorf("profiles after reopen = %v", names)
	}
	got, ok := again.Get(p.ID)
	if !ok || got.Host != "db.example.net" {
		t.Errorf("Get(%s) = %+v, %v", p.ID, got, ok)
	}
	if _, ok := again.Get("nope"); ok {
		t.Error("Get found a profile that does not exist")
	}
}

func TestSaveUpdatesInPlace(t *testing.T) {
	s := openTestStore(t)
	p, _ := s.Save(Profile{Name: "one", Host: "a"})
	p.Host = "b"
	if _, err := s.Save(p); err != nil {
		t.Fatal(err)
	}
	if list := s.List(); len(list) != 1 || list[0].Host != "b" {
		t.Errorf("after update: %+v", list)
	}
}

// TestDeleteRemovesTheProfileAndItsPassword: a deleted profile must not leave
// its password behind in the secrets file.
func TestDeleteRemovesTheProfileAndItsPassword(t *testing.T) {
	s := openTestStore(t)
	p, _ := s.Save(Profile{Name: "one", Host: "a"})
	if err := s.SetPassword(p.ID, "hunter2"); err != nil {
		t.Fatal(err)
	}
	if pw, ok, err := s.GetPassword(p.ID); err != nil || !ok || pw != "hunter2" {
		t.Fatalf("GetPassword = %q %v %v", pw, ok, err)
	}
	if err := s.Delete(p.ID); err != nil {
		t.Fatal(err)
	}
	if len(s.List()) != 0 {
		t.Error("profile survived Delete")
	}
	if _, ok, _ := s.GetPassword(p.ID); ok {
		t.Error("password survived Delete")
	}
	if err := s.DeletePassword("never-stored"); err != nil {
		t.Errorf("deleting an absent password: %v", err)
	}
}

func TestSecretsFileIsPrivate(t *testing.T) {
	s := openTestStore(t)
	p, _ := s.Save(Profile{Name: "one", Host: "a"})
	if err := s.SetPassword(p.ID, "hunter2"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"connections.json", "secrets.json"} {
		fi, err := os.Stat(filepath.Join(s.Dir(), name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s has mode %o, want 0600", name, fi.Mode().Perm())
		}
	}
	// The profile file never carries the password.
	data, _ := os.ReadFile(filepath.Join(s.Dir(), "connections.json"))
	if strings.Contains(string(data), "hunter2") {
		t.Error("password written into connections.json")
	}
}

func TestCorruptProfilesFileIsReported(t *testing.T) {
	s := openTestStore(t)
	if err := os.WriteFile(filepath.Join(s.Dir(), "connections.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(); err == nil || !strings.Contains(err.Error(), "connections.json") {
		t.Errorf("err = %v, want the file named", err)
	}
}

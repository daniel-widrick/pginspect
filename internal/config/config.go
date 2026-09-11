// Package config stores saved connection profiles and their secrets.
//
// Profiles live in a JSON file under the user's config directory. Passwords
// are kept in the OS keychain via go-keyring; set PGINSPECT_NO_KEYRING=1 to
// store them in a mode 0600 file next to the profiles instead (useful in
// development, where an unsigned binary triggers keychain prompts on every
// rebuild).
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/zalando/go-keyring"
)

const keyringService = "pginspect"

// Profile is a saved connection. The password is never stored here.
type Profile struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Database     string `json:"database"`
	User         string `json:"user"`
	SSLMode      string `json:"sslMode"`
	SavePassword bool   `json:"savePassword"`
	Color        string `json:"color"`
}

// Store persists profiles and passwords.
type Store struct {
	mu       sync.Mutex
	dir      string
	profiles []Profile
	// fileSecrets is used instead of the keychain when PGINSPECT_NO_KEYRING is set.
	fileSecrets bool
}

// Open loads the store from the platform config directory, creating it if needed.
func Open() (*Store, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(base, "pginspect")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, fileSecrets: os.Getenv("PGINSPECT_NO_KEYRING") != ""}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// Dir returns the directory holding the config files.
func (s *Store) Dir() string { return s.dir }

func (s *Store) profilesPath() string { return filepath.Join(s.dir, "connections.json") }
func (s *Store) secretsPath() string  { return filepath.Join(s.dir, "secrets.json") }

func (s *Store) load() error {
	data, err := os.ReadFile(s.profilesPath())
	if errors.Is(err, os.ErrNotExist) {
		s.profiles = nil
		return nil
	}
	if err != nil {
		return err
	}
	var wrapper struct {
		Profiles []Profile `json:"profiles"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return fmt.Errorf("parse %s: %w", s.profilesPath(), err)
	}
	s.profiles = wrapper.Profiles
	return nil
}

func (s *Store) flush() error {
	wrapper := struct {
		Profiles []Profile `json:"profiles"`
	}{Profiles: s.profiles}
	data, err := json.MarshalIndent(wrapper, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.profilesPath(), data, 0o600)
}

// List returns all profiles sorted by name.
func (s *Store) List() []Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Profile, len(s.profiles))
	copy(out, s.profiles)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns the profile with the given ID.
func (s *Store) Get(id string) (Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.profiles {
		if p.ID == id {
			return p, true
		}
	}
	return Profile{}, false
}

// Save inserts or updates a profile. A profile without an ID gets a new one.
func (s *Store) Save(p Profile) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.ID == "" {
		p.ID = newID()
	}
	if p.Port == 0 {
		p.Port = 5432
	}
	if p.SSLMode == "" {
		p.SSLMode = "prefer"
	}
	replaced := false
	for i := range s.profiles {
		if s.profiles[i].ID == p.ID {
			s.profiles[i] = p
			replaced = true
			break
		}
	}
	if !replaced {
		s.profiles = append(s.profiles, p)
	}
	return p, s.flush()
}

// Delete removes a profile and its stored password.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.profiles[:0]
	for _, p := range s.profiles {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	s.profiles = kept
	_ = s.deletePassword(id)
	return s.flush()
}

// SetPassword stores a password for the profile.
func (s *Store) SetPassword(id, password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fileSecrets {
		secrets, err := s.readSecrets()
		if err != nil {
			return err
		}
		secrets[id] = password
		return s.writeSecrets(secrets)
	}
	return keyring.Set(keyringService, id, password)
}

// GetPassword returns the stored password, or "" and false if none is stored.
func (s *Store) GetPassword(id string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fileSecrets {
		secrets, err := s.readSecrets()
		if err != nil {
			return "", false, err
		}
		pw, ok := secrets[id]
		return pw, ok, nil
	}
	pw, err := keyring.Get(keyringService, id)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return pw, true, nil
}

// DeletePassword removes any stored password for the profile.
func (s *Store) DeletePassword(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deletePassword(id)
}

func (s *Store) deletePassword(id string) error {
	if s.fileSecrets {
		secrets, err := s.readSecrets()
		if err != nil {
			return err
		}
		delete(secrets, id)
		return s.writeSecrets(secrets)
	}
	err := keyring.Delete(keyringService, id)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

func (s *Store) readSecrets() (map[string]string, error) {
	data, err := os.ReadFile(s.secretsPath())
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) writeSecrets(m map[string]string) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.secretsPath(), data, 0o600)
}

func writeAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

package db

import (
	"context"
	"errors"
	"sync"

	"pginspect/internal/config"
)

// ErrNotConnected is returned when a profile has no open session.
var ErrNotConnected = errors.New("not connected")

// Manager tracks open sessions keyed by profile ID.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewManager creates an empty manager.
func NewManager() *Manager {
	return &Manager{sessions: map[string]*Session{}}
}

// Connect opens a session for the profile, replacing any existing one.
func (m *Manager) Connect(ctx context.Context, p config.Profile, password string) (*Session, error) {
	s, err := Open(ctx, p, password)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if old, ok := m.sessions[p.ID]; ok {
		old.Close()
	}
	m.sessions[p.ID] = s
	m.mu.Unlock()
	return s, nil
}

// Get returns the session for a profile.
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotConnected
	}
	return s, nil
}

// Disconnect closes and forgets a session.
func (m *Manager) Disconnect(id string) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if ok {
		s.Close()
	}
}

// ConnectedIDs lists profiles with open sessions.
func (m *Manager) ConnectedIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	return ids
}

// CloseAll shuts every session down.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.sessions {
		s.Close()
		delete(m.sessions, id)
	}
}

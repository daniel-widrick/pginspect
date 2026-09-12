package db

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// QueryExample is a real statement text, with its constants, observed in
// pg_stat_activity for a given query_id.
type QueryExample struct {
	QueryID   string    `json:"queryId"`
	Query     string    `json:"query"`
	User      string    `json:"user"`
	Database  string    `json:"database"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
	// Count is how many distinct executions of this exact text were seen.
	Count int `json:"count"`
}

// SamplingStatus reports the activity sampler for a session.
type SamplingStatus struct {
	Supported bool   `json:"supported"`
	Running   bool   `json:"running"`
	Message   string `json:"message"`
	// Samples is the number of pg_stat_activity reads taken so far.
	Samples int `json:"samples"`
	// MaxQueryLength is track_activity_query_size; longer texts are cut.
	MaxQueryLength int `json:"maxQueryLength"`
	// Counts maps query_id to the number of distinct example texts held.
	Counts map[string]int `json:"counts"`
}

const (
	sampleInterval      = time.Second
	maxExamplesPerQuery = 8
)

type sampler struct {
	mu      sync.Mutex
	cancel  context.CancelFunc
	running bool
	// conn is dedicated to the sampler. Polling through the pool would
	// overwrite the "last query" text of whichever backend it borrowed.
	conn     *pgx.Conn
	samples  int
	maxLen   int
	examples map[string][]*QueryExample // by query_id
	// seen prevents counting one execution twice across samples.
	seen map[sampleKey]struct{}
}

type sampleKey struct {
	pid   int
	start time.Time
}

func (s *Session) samplerState() *sampler {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sampler == nil {
		s.sampler = &sampler{examples: map[string][]*QueryExample{}, seen: map[sampleKey]struct{}{}}
	}
	return s.sampler
}

// StartSampling begins polling pg_stat_activity once a second. It needs
// PostgreSQL 14 or newer with compute_query_id enabled (automatic when
// pg_stat_statements is loaded).
func (s *Session) StartSampling(ctx context.Context) error {
	var major, maxLen int
	var computeQueryID string
	// track_activity_query_size is reported with units ("1kB"), so read the
	// raw byte value from pg_settings. compute_query_id only exists from 14.
	err := s.pool.QueryRow(ctx, `
		select current_setting('server_version_num')::int / 10000,
		       (select setting::int from pg_catalog.pg_settings where name = 'track_activity_query_size'),
		       coalesce((select setting from pg_catalog.pg_settings where name = 'compute_query_id'), 'missing')`).
		Scan(&major, &maxLen, &computeQueryID)
	if err != nil {
		return fmt.Errorf("read server settings: %w", err)
	}
	if major < 14 || computeQueryID == "missing" {
		return errors.New("query_id in pg_stat_activity needs PostgreSQL 14 or newer")
	}
	if computeQueryID == "off" {
		return errors.New("compute_query_id is off; set it to on (or auto with pg_stat_statements loaded)")
	}
	sm := s.samplerState()
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.maxLen = maxLen
	if sm.running {
		return nil
	}
	conn, err := s.dialSampler(ctx)
	if err != nil {
		return err
	}
	sm.conn = conn
	loopCtx, cancel := context.WithCancel(context.Background())
	sm.cancel = cancel
	sm.running = true
	go s.sampleLoop(loopCtx, sm)
	return nil
}

func (s *Session) dialSampler(ctx context.Context) (*pgx.Conn, error) {
	cfg := s.pool.Config().ConnConfig.Copy()
	cfg.RuntimeParams["application_name"] = "pginspect sampler"
	return pgx.ConnectConfig(ctx, cfg)
}

// StopSampling halts the poller; collected examples are kept.
func (s *Session) StopSampling() {
	sm := s.samplerState()
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.cancel != nil {
		sm.cancel()
	}
	sm.running = false
	if sm.conn != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = sm.conn.Close(closeCtx)
		cancel()
		sm.conn = nil
	}
}

func (s *Session) sampleLoop(ctx context.Context, sm *sampler) {
	t := time.NewTicker(sampleInterval)
	defer t.Stop()
	s.sampleOnce(ctx, sm)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sampleOnce(ctx, sm)
		}
	}
}

func (s *Session) sampleOnce(ctx context.Context, sm *sampler) {
	qctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	sm.mu.Lock()
	conn := sm.conn
	sm.mu.Unlock()
	if conn == nil || conn.IsClosed() {
		fresh, err := s.dialSampler(qctx)
		if err != nil {
			return
		}
		sm.mu.Lock()
		sm.conn = fresh
		sm.mu.Unlock()
		conn = fresh
	}
	rows, err := conn.Query(qctx, `
		select pid, query_id::text, query, coalesce(usename, ''), coalesce(datname, ''), query_start
		from pg_catalog.pg_stat_activity
		where query_id is not null and query <> '' and query_start is not null
		  and pid <> pg_backend_pid() and backend_type = 'client backend'`)
	if err != nil {
		if ctx.Err() == nil {
			// Drop the connection so the next tick redials.
			closeCtx, c := context.WithTimeout(context.Background(), time.Second)
			_ = conn.Close(closeCtx)
			c()
		}
		return
	}
	defer rows.Close()
	now := time.Now()
	type row struct {
		pid      int
		qid, q   string
		user, db string
		start    time.Time
	}
	var batch []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.pid, &r.qid, &r.q, &r.user, &r.db, &r.start); err != nil {
			return
		}
		batch = append(batch, r)
	}
	if rows.Err() != nil {
		return
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.samples++
	// Forget executions older than a few minutes so the set stays small.
	for k := range sm.seen {
		if now.Sub(k.start) > 5*time.Minute {
			delete(sm.seen, k)
		}
	}
	for _, r := range batch {
		key := sampleKey{pid: r.pid, start: r.start}
		if _, dup := sm.seen[key]; dup {
			continue
		}
		sm.seen[key] = struct{}{}
		list := sm.examples[r.qid]
		found := false
		for _, ex := range list {
			if ex.Query == r.q {
				ex.Count++
				ex.LastSeen = now
				found = true
				break
			}
		}
		if found {
			continue
		}
		ex := &QueryExample{QueryID: r.qid, Query: r.q, User: r.user, Database: r.db, FirstSeen: now, LastSeen: now, Count: 1}
		list = append(list, ex)
		if len(list) > maxExamplesPerQuery {
			// Drop the example seen least recently.
			sort.Slice(list, func(i, j int) bool { return list[i].LastSeen.After(list[j].LastSeen) })
			list = list[:maxExamplesPerQuery]
		}
		sm.examples[r.qid] = list
	}
}

// Sampling returns the sampler's status and per-query example counts.
func (s *Session) Sampling() SamplingStatus {
	sm := s.samplerState()
	sm.mu.Lock()
	defer sm.mu.Unlock()
	st := SamplingStatus{Supported: true, Running: sm.running, Samples: sm.samples, MaxQueryLength: sm.maxLen, Counts: map[string]int{}}
	for qid, list := range sm.examples {
		st.Counts[qid] = len(list)
	}
	return st
}

// Examples returns collected example texts for a query_id, most recent first.
func (s *Session) Examples(queryID string) []QueryExample {
	sm := s.samplerState()
	sm.mu.Lock()
	defer sm.mu.Unlock()
	out := make([]QueryExample, 0, len(sm.examples[queryID]))
	for _, ex := range sm.examples[queryID] {
		out = append(out, *ex)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

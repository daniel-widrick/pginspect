// Package db manages live Postgres connections and runs queries against them.
package db

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgconn/ctxwatch"
	"github.com/jackc/pgx/v5/pgxpool"

	"pginspect/internal/config"
)

// Column describes one column of a result set.
type Column struct {
	Name    string `json:"name"`
	TypeOID uint32 `json:"typeOid"`
	Type    string `json:"type"`
}

// Result is the outcome of one statement. Rows hold the server's text
// representation of each value; nil means SQL NULL.
type Result struct {
	Columns      []Column    `json:"columns"`
	Rows         [][]*string `json:"rows"`
	RowCount     int         `json:"rowCount"`
	Truncated    bool        `json:"truncated"`
	Command      string      `json:"command"`
	RowsAffected int64       `json:"rowsAffected"`
}

// QueryResponse is what RunQuery hands back. Results that completed before an
// error are kept, so a failing multi-statement script still shows what ran.
type QueryResponse struct {
	Results    []Result `json:"results"`
	Error      string   `json:"error"`
	DurationMs int64    `json:"durationMs"`
	Cancelled  bool     `json:"cancelled"`
	// TimedOut is set when statement_timeout stopped the statement.
	TimedOut bool `json:"timedOut"`
	// LimitStopped is set when a SELECT was cancelled server-side after the
	// row limit was reached, so the rest of the result was never streamed.
	LimitStopped bool `json:"limitStopped"`
}

// Info describes an open connection.
type Info struct {
	ID            string `json:"id"`
	ServerVersion string `json:"serverVersion"`
	Database      string `json:"database"`
	User          string `json:"user"`
}

// Session is one open connection profile. A small pool lets several editor
// tabs run queries concurrently; each RunQuery acquires a connection for the
// duration of the statement batch.
type Session struct {
	Profile config.Profile
	pool    *pgxpool.Pool

	mu        sync.Mutex
	running   map[string]context.CancelFunc
	typeNames map[uint32]string
	sampler   *sampler
}

// DSN builds a connection string for the profile.
func DSN(p config.Profile, password string) string {
	u := url.URL{
		Scheme: "postgres",
		Host:   net.JoinHostPort(p.Host, strconv.Itoa(p.Port)),
		Path:   "/" + p.Database,
	}
	if password != "" {
		u.User = url.UserPassword(p.User, password)
	} else {
		u.User = url.User(p.User)
	}
	q := url.Values{}
	if p.SSLMode != "" {
		q.Set("sslmode", p.SSLMode)
	}
	q.Set("application_name", "pginspect")
	u.RawQuery = q.Encode()
	return u.String()
}

// Open connects using the profile and returns a ready session.
func Open(ctx context.Context, p config.Profile, password string) (*Session, error) {
	cfg, err := pgxpool.ParseConfig(DSN(p, password))
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 4
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.ConnConfig.ConnectTimeout = 10 * time.Second
	// Cancel a query by asking the server to stop it, so the connection stays
	// usable; only if the server ignores that is the socket closed.
	cfg.ConnConfig.BuildContextWatcherHandler = func(c *pgconn.PgConn) ctxwatch.Handler {
		return &pgconn.CancelRequestContextWatcherHandler{Conn: c, CancelRequestDelay: 0, DeadlineDelay: 10 * time.Second}
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Session{
		Profile:   p,
		pool:      pool,
		running:   map[string]context.CancelFunc{},
		typeNames: map[uint32]string{},
	}, nil
}

// Close shuts the pool down, cancelling any running queries.
func (s *Session) Close() {
	s.mu.Lock()
	for _, cancel := range s.running {
		cancel()
	}
	s.running = map[string]context.CancelFunc{}
	sm := s.sampler
	s.mu.Unlock()
	if sm != nil {
		s.StopSampling()
	}
	s.pool.Close()
}

// Info queries the server for version and identity.
func (s *Session) Info(ctx context.Context) (Info, error) {
	var info Info
	info.ID = s.Profile.ID
	err := s.pool.QueryRow(ctx,
		`select current_setting('server_version'), current_database(), current_user`).
		Scan(&info.ServerVersion, &info.Database, &info.User)
	return info, err
}

// Cancel aborts the query with the given ID, if it is still running.
func (s *Session) Cancel(queryID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cancel, ok := s.running[queryID]
	if ok {
		cancel()
	}
	return ok
}

// RunQuery executes a script using the simple query protocol, so it may hold
// several statements. Values come back as the server's text form. At most
// maxRows rows per result are kept. For a single plain SELECT the statement
// is cancelled server-side once the limit is reached, so a huge table does
// not have to stream in full; other statements are drained and counted.
// timeoutMs > 0 applies statement_timeout for this run only.
func (s *Session) RunQuery(ctx context.Context, queryID, sql string, maxRows int, timeoutMs int) QueryResponse {
	if maxRows <= 0 {
		maxRows = 1000
	}
	ctx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.running[queryID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, queryID)
		s.mu.Unlock()
		cancel()
	}()

	start := time.Now()
	resp := QueryResponse{Results: []Result{}}
	finish := func(err error) QueryResponse {
		resp.DurationMs = time.Since(start).Milliseconds()
		if err != nil {
			if resp.LimitStopped && isCancelledPgError(err) {
				// We asked for the cancel; the results kept so far are the answer.
				return resp
			}
			resp.Error = describeError(err)
			resp.TimedOut = isTimeoutPgError(err)
			resp.Cancelled = !resp.TimedOut && (errors.Is(ctx.Err(), context.Canceled) || isCancelledPgError(err))
		}
		return resp
	}

	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return finish(err)
	}
	defer conn.Release()
	if timeoutMs > 0 {
		if _, err := conn.Exec(ctx, fmt.Sprintf("SET statement_timeout = %d", timeoutMs)); err != nil {
			return finish(err)
		}
		defer func() {
			rctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, _ = conn.Exec(rctx, "RESET statement_timeout")
			cancel()
		}()
	}
	stopAtLimit := IsPlainSelect(sql)
	return finish(s.runScript(ctx, conn.Conn(), sql, maxRows, stopAtLimit, &resp))
}

// runScript executes a script on conn, appending completed statements to
// resp. With stopAtLimit, the statement is cancelled once maxRows rows have
// been kept and resp.LimitStopped is set.
func (s *Session) runScript(ctx context.Context, conn *pgx.Conn, sql string, maxRows int, stopAtLimit bool, resp *QueryResponse) error {
	mrr := conn.PgConn().Exec(ctx, sql)
	for mrr.NextResult() {
		rr := mrr.ResultReader()
		res := Result{Rows: [][]*string{}}
		for _, fd := range rr.FieldDescriptions() {
			res.Columns = append(res.Columns, Column{
				Name:    fd.Name,
				TypeOID: fd.DataTypeOID,
				Type:    s.typeName(conn, fd.DataTypeOID),
			})
		}
		for rr.NextRow() {
			res.RowCount++
			if res.RowCount > maxRows {
				res.Truncated = true
				if stopAtLimit && !resp.LimitStopped {
					resp.LimitStopped = true
					cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					_ = conn.PgConn().CancelRequest(cctx)
					cancel()
				}
				continue
			}
			vals := rr.Values()
			row := make([]*string, len(vals))
			for i, v := range vals {
				if v != nil {
					str := string(v)
					row[i] = &str
				}
			}
			res.Rows = append(res.Rows, row)
		}
		tag, err := rr.Close()
		if err != nil {
			if resp.LimitStopped && isCancelledPgError(err) {
				res.Command = "SELECT"
				res.RowCount = maxRows
			}
			resp.Results = append(resp.Results, res)
			_ = mrr.Close()
			return err
		}
		res.Command = tag.String()
		res.RowsAffected = tag.RowsAffected()
		resp.Results = append(resp.Results, res)
	}
	return mrr.Close()
}

// ExplainResponse carries a plan in EXPLAIN's JSON format.
type ExplainResponse struct {
	Plan    string `json:"plan"`
	Analyze bool   `json:"analyze"`
	// Generic is set when the plan was produced with GENERIC_PLAN (PG16+),
	// which plans a statement containing $n parameters without values.
	Generic    bool   `json:"generic"`
	Error      string `json:"error"`
	DurationMs int64  `json:"durationMs"`
	Cancelled  bool   `json:"cancelled"`
	TimedOut   bool   `json:"timedOut"`
	// SQL is the statement that was explained, so the plan viewer can
	// analyse the query text alongside the plan.
	SQL string `json:"sql"`
}

// Explain runs EXPLAIN (FORMAT JSON) on a single statement. With analyze the
// statement really executes, inside a transaction that is always rolled back,
// so explaining an UPDATE or DELETE leaves no trace. With generic, the
// statement may contain $1-style parameters and is planned without values
// (PostgreSQL 16 or newer); analyze and generic are mutually exclusive.
func (s *Session) Explain(ctx context.Context, queryID, sql string, analyze, generic bool, timeoutMs int) ExplainResponse {
	stmt := strings.TrimSpace(sql)
	stmt = strings.TrimRight(stmt, "; \t\r\n")
	if stmt == "" {
		return ExplainResponse{Error: "nothing to explain"}
	}
	if analyze && generic {
		return ExplainResponse{Error: "a generic plan cannot be combined with ANALYZE"}
	}
	opts := "FORMAT JSON, COSTS, SETTINGS"
	if analyze {
		opts = "ANALYZE, BUFFERS, TIMING, " + opts
	}
	if generic {
		opts = "GENERIC_PLAN, " + opts
	}
	script := "EXPLAIN (" + opts + ")\n" + stmt
	if analyze {
		script = "BEGIN;\n" + script + ";\nROLLBACK;"
	}

	ctx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.running[queryID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, queryID)
		s.mu.Unlock()
		cancel()
	}()

	start := time.Now()
	out := ExplainResponse{Analyze: analyze, Generic: generic, SQL: stmt}
	finish := func(err error) ExplainResponse {
		out.DurationMs = time.Since(start).Milliseconds()
		if err != nil {
			out.Error = describeError(err)
			out.TimedOut = isTimeoutPgError(err)
			out.Cancelled = !out.TimedOut && (errors.Is(ctx.Err(), context.Canceled) || isCancelledPgError(err))
		}
		return out
	}

	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return finish(err)
	}
	defer conn.Release()

	if timeoutMs > 0 {
		if _, err := conn.Exec(ctx, fmt.Sprintf("SET statement_timeout = %d", timeoutMs)); err != nil {
			return finish(err)
		}
		defer func() {
			rctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, _ = conn.Exec(rctx, "RESET statement_timeout")
			cancel()
		}()
	}
	resp := QueryResponse{}
	err = s.runScript(ctx, conn.Conn(), script, 10000, false, &resp)
	if analyze && conn.Conn().PgConn().TxStatus() != 'I' {
		// The script stopped before its ROLLBACK; do not hand an aborted
		// transaction back to the pool.
		rbCtx, rbCancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _ = conn.Conn().PgConn().Exec(rbCtx, "ROLLBACK").ReadAll()
		rbCancel()
	}
	if err != nil {
		return finish(err)
	}
	for _, r := range resp.Results {
		if len(r.Columns) == 1 && r.Columns[0].Name == "QUERY PLAN" {
			var b strings.Builder
			for _, row := range r.Rows {
				if row[0] != nil {
					b.WriteString(*row[0])
				}
			}
			out.Plan = b.String()
		}
	}
	if out.Plan == "" {
		return finish(errors.New("server returned no plan"))
	}
	return finish(nil)
}

// typeName resolves an OID to a type name, using pgx's registry first and
// falling back to pg_type for user-defined types.
func (s *Session) typeName(conn *pgx.Conn, oid uint32) string {
	if t, ok := conn.TypeMap().TypeForOID(oid); ok {
		return t.Name
	}
	s.mu.Lock()
	name, ok := s.typeNames[oid]
	s.mu.Unlock()
	if ok {
		return name
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Use a separate pool connection: the calling connection is mid-result.
	err := s.pool.QueryRow(ctx, `select typname from pg_catalog.pg_type where oid = $1`, oid).Scan(&name)
	if err != nil {
		name = fmt.Sprintf("oid:%d", oid)
	}
	s.mu.Lock()
	s.typeNames[oid] = name
	s.mu.Unlock()
	return name
}

func isCancelledPgError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "57014" && !strings.Contains(pgErr.Message, "statement timeout")
}

func isTimeoutPgError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "57014" && strings.Contains(pgErr.Message, "statement timeout")
}

var leadingCommentRe = regexp.MustCompile(`(?s)^\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*`)

// IsPlainSelect reports whether sql is a single read-only statement
// (SELECT, WITH, TABLE or VALUES) with no data-modifying CTE, so it is safe
// to cancel once enough rows have been read. Anything else, including a
// script of several statements, is streamed in full.
func IsPlainSelect(sql string) bool {
	body := strings.TrimSpace(leadingCommentRe.ReplaceAllString(sql, ""))
	body = strings.TrimRight(body, "; \t\r\n")
	if body == "" || strings.Contains(body, ";") {
		return false
	}
	lower := strings.ToLower(body)
	switch {
	case strings.HasPrefix(lower, "select"), strings.HasPrefix(lower, "table"), strings.HasPrefix(lower, "values"):
	case strings.HasPrefix(lower, "with"):
		for _, kw := range []string{"insert", "update", "delete", "merge"} {
			if regexp.MustCompile(`\b` + kw + `\b`).MatchString(lower) {
				return false
			}
		}
	default:
		return false
	}
	return !regexp.MustCompile(`\b(?:into|for\s+update|for\s+share|for\s+no\s+key\s+update|for\s+key\s+share)\b`).MatchString(lower)
}

// describeError formats Postgres errors with position and detail information.
func describeError(err error) string {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err.Error()
	}
	msg := fmt.Sprintf("%s: %s", pgErr.Severity, pgErr.Message)
	if pgErr.Detail != "" {
		msg += "\nDETAIL: " + pgErr.Detail
	}
	if pgErr.Hint != "" {
		msg += "\nHINT: " + pgErr.Hint
	}
	if pgErr.Position > 0 {
		msg += fmt.Sprintf("\nPOSITION: %d", pgErr.Position)
	}
	if pgErr.Where != "" {
		msg += "\nWHERE: " + pgErr.Where
	}
	return msg + fmt.Sprintf("\nSQLSTATE %s", pgErr.Code)
}

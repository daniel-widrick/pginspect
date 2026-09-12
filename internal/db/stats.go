package db

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// StatStatement is one row of pg_stat_statements, normalised across versions.
type StatStatement struct {
	QueryID       string  `json:"queryId"`
	Query         string  `json:"query"`
	User          string  `json:"user"`
	Database      string  `json:"database"`
	TopLevel      bool    `json:"topLevel"`
	Calls         int64   `json:"calls"`
	TotalMs       float64 `json:"totalMs"`
	MeanMs        float64 `json:"meanMs"`
	MinMs         float64 `json:"minMs"`
	MaxMs         float64 `json:"maxMs"`
	StddevMs      float64 `json:"stddevMs"`
	PlanMs        float64 `json:"planMs"`
	Rows          int64   `json:"rows"`
	SharedHit     int64   `json:"sharedHit"`
	SharedRead    int64   `json:"sharedRead"`
	SharedDirtied int64   `json:"sharedDirtied"`
	SharedWritten int64   `json:"sharedWritten"`
	TempRead      int64   `json:"tempRead"`
	TempWritten   int64   `json:"tempWritten"`
	IOReadMs      float64 `json:"ioReadMs"`
	IOWriteMs     float64 `json:"ioWriteMs"`
	WalBytes      int64   `json:"walBytes"`
}

// StatsResponse is the result of reading pg_stat_statements.
type StatsResponse struct {
	// Available is false when the extension is not installed in this database.
	Available bool `json:"available"`
	// Installable is true when the extension exists on the server but has not
	// been created in this database.
	Installable bool `json:"installable"`
	// Preloaded reports whether shared_preload_libraries includes the module.
	Preloaded  bool            `json:"preloaded"`
	Message    string          `json:"message"`
	StatsReset string          `json:"statsReset"`
	Statements []StatStatement `json:"statements"`
	TotalMs    float64         `json:"totalMs"`
	TotalCalls int64           `json:"totalCalls"`
}

// StatStatements reads pg_stat_statements. With currentDBOnly, rows from other
// databases on the server are skipped.
func (s *Session) StatStatements(ctx context.Context, currentDBOnly bool, limit int) (StatsResponse, error) {
	if limit <= 0 {
		limit = 500
	}
	resp := StatsResponse{Statements: []StatStatement{}}

	var preload string
	if err := s.pool.QueryRow(ctx, `select current_setting('shared_preload_libraries', true)`).Scan(&preload); err == nil {
		resp.Preloaded = strings.Contains(preload, "pg_stat_statements")
	}

	var installed, installable bool
	err := s.pool.QueryRow(ctx, `
		select exists (select 1 from pg_catalog.pg_extension where extname = 'pg_stat_statements'),
		       exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_stat_statements')`).
		Scan(&installed, &installable)
	if err != nil {
		return resp, err
	}
	resp.Installable = installable && !installed
	if !installed {
		switch {
		case !installable:
			resp.Message = "The pg_stat_statements extension is not available on this server (contrib package missing)."
		case !resp.Preloaded:
			resp.Message = "pg_stat_statements must be added to shared_preload_libraries in postgresql.conf, followed by a server restart, before CREATE EXTENSION works."
		default:
			resp.Message = "pg_stat_statements is available but not installed in this database."
		}
		return resp, nil
	}
	resp.Available = true

	// Column names changed in PG13 (total_time -> total_exec_time) and PG17
	// (blk_read_time -> shared_blk_read_time), so pull the row as JSON and
	// map whichever keys exist.
	cols := map[string]bool{}
	rows, err := s.pool.Query(ctx, `
		select a.attname
		from pg_catalog.pg_attribute a
		join pg_catalog.pg_class c on c.oid = a.attrelid
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		join pg_catalog.pg_extension e on e.extnamespace = n.oid and e.extname = 'pg_stat_statements'
		where c.relname = 'pg_stat_statements' and a.attnum > 0 and not a.attisdropped`)
	if err != nil {
		return resp, err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return resp, err
	}
	for _, n := range names {
		cols[n] = true
	}
	orderCol := "total_exec_time"
	if !cols[orderCol] {
		orderCol = "total_time"
	}
	if !cols[orderCol] {
		return resp, fmt.Errorf("unrecognised pg_stat_statements layout (no %s column)", orderCol)
	}

	where := ""
	if currentDBOnly {
		where = "where s.dbid = (select oid from pg_catalog.pg_database where datname = current_database())"
	}
	q := fmt.Sprintf(`
		select (to_jsonb(s) || jsonb_build_object('usename', r.rolname, 'datname', d.datname))::text
		from pg_stat_statements s
		left join pg_catalog.pg_roles r on r.oid = s.userid
		left join pg_catalog.pg_database d on d.oid = s.dbid
		%s
		order by s.%s desc
		limit %d`, where, orderCol, limit)
	rows, err = s.pool.Query(ctx, q)
	if err != nil {
		return resp, err
	}
	raws, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return resp, err
	}
	for _, raw := range raws {
		// UseNumber keeps 64-bit values such as queryid exact; float64 would
		// round anything above 2^53.
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.UseNumber()
		var m map[string]any
		if err := dec.Decode(&m); err != nil {
			return resp, err
		}
		resp.Statements = append(resp.Statements, statFromMap(m))
	}

	// Totals cover every statement, not just the returned page.
	totalQ := fmt.Sprintf(`select coalesce(sum(s.%s), 0), coalesce(sum(s.calls), 0) from pg_stat_statements s %s`, orderCol, where)
	if err := s.pool.QueryRow(ctx, totalQ).Scan(&resp.TotalMs, &resp.TotalCalls); err != nil {
		return resp, err
	}
	// pg_stat_statements_info exists from PG14; ignore errors on older servers.
	var reset *string
	_ = s.pool.QueryRow(ctx, `select stats_reset::text from pg_stat_statements_info`).Scan(&reset)
	if reset != nil {
		resp.StatsReset = *reset
	}
	return resp, nil
}

func statFromMap(m map[string]any) StatStatement {
	f := func(keys ...string) float64 {
		for _, k := range keys {
			if v, ok := m[k].(json.Number); ok {
				if x, err := v.Float64(); err == nil {
					return x
				}
			}
		}
		return 0
	}
	i := func(keys ...string) int64 {
		for _, k := range keys {
			if v, ok := m[k].(json.Number); ok {
				if x, err := v.Int64(); err == nil {
					return x
				}
				if x, err := v.Float64(); err == nil {
					return int64(x)
				}
			}
		}
		return 0
	}
	str := func(k string) string {
		switch v := m[k].(type) {
		case string:
			return v
		case json.Number:
			return v.String()
		}
		return ""
	}
	topLevel := true
	if v, ok := m["toplevel"].(bool); ok {
		topLevel = v
	}
	return StatStatement{
		QueryID:       str("queryid"),
		Query:         str("query"),
		User:          str("usename"),
		Database:      str("datname"),
		TopLevel:      topLevel,
		Calls:         i("calls"),
		TotalMs:       f("total_exec_time", "total_time"),
		MeanMs:        f("mean_exec_time", "mean_time"),
		MinMs:         f("min_exec_time", "min_time"),
		MaxMs:         f("max_exec_time", "max_time"),
		StddevMs:      f("stddev_exec_time", "stddev_time"),
		PlanMs:        f("total_plan_time"),
		Rows:          i("rows"),
		SharedHit:     i("shared_blks_hit"),
		SharedRead:    i("shared_blks_read"),
		SharedDirtied: i("shared_blks_dirtied"),
		SharedWritten: i("shared_blks_written"),
		TempRead:      i("temp_blks_read"),
		TempWritten:   i("temp_blks_written"),
		IOReadMs:      f("shared_blk_read_time", "blk_read_time"),
		IOWriteMs:     f("shared_blk_write_time", "blk_write_time"),
		WalBytes:      i("wal_bytes"),
	}
}

// ResetStatStatements clears the counters.
func (s *Session) ResetStatStatements(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `select pg_stat_statements_reset()`)
	return err
}

// InstallStatStatements creates the extension in the current database.
func (s *Session) InstallStatStatements(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `create extension if not exists pg_stat_statements`)
	return err
}

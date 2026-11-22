package db

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// reportPlan is the EXPLAIN output written for one statement in a report.
type reportPlan struct {
	// SQL is the statement explained, Source says where it came from.
	SQL     string
	Source  string
	Analyze bool
	Generic bool
	Plan    string
	Error   string
	// Note says why the plan is not what was asked for, such as ANALYZE
	// skipped for a statement that writes.
	Note string
	// Tables are the relations the plan reads, as schema-qualified names.
	Tables []relRef
}

type relRef struct{ Schema, Name string }

func (r relRef) String() string { return QualifiedName(r.Schema, r.Name) }

const (
	reportPlainExplainTimeout = 15 * time.Second
	reportMaxTables           = 60
)

var (
	sqlComments = regexp.MustCompile(`(?s)^\s*(?:--[^\n]*\n|/\*.*?\*/)\s*`)
	firstWord   = regexp.MustCompile(`^\s*\(*\s*([A-Za-z]+)`)
	writeWord   = regexp.MustCompile(`(?i)\b(insert|update|delete|merge)\b`)
)

// leadingKeyword returns the statement's first keyword in lower case,
// skipping comments and opening parentheses.
func leadingKeyword(sql string) string {
	for {
		next := sqlComments.ReplaceAllString(sql, "")
		if next == sql {
			break
		}
		sql = next
	}
	m := firstWord.FindStringSubmatch(sql)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
}

// explainable reports whether EXPLAIN accepts the statement at all.
func explainable(sql string) bool {
	switch leadingKeyword(sql) {
	case "select", "insert", "update", "delete", "merge", "values", "table", "with":
		return true
	}
	return false
}

// readOnly reports whether a statement only reads, so EXPLAIN ANALYZE may
// run it. Writes are rolled back by the explain script anyway, but they take
// row locks, fire triggers and advance sequences, so the report leaves them
// to a person to run. Volatile functions inside a SELECT cannot be seen here.
func readOnly(sql string) bool {
	switch leadingKeyword(sql) {
	case "select", "values", "table":
		return true
	case "with":
		return !writeWord.MatchString(fingerprint(sql))
	}
	return false
}

// planTarget picks the statement text to explain: the slowest logged
// execution with its values, else a captured literal text, else the
// normalised statement, which needs a generic plan when it has placeholders.
func planTarget(st StatStatement, logged []SlowLogEntry, captured []QueryExample, maxLen int) (sql, source string, generic bool) {
	for _, e := range logged {
		q := Substitute(e.Query, e.Params)
		if !fpParam.MatchString(q) {
			return q, fmt.Sprintf("the slowest logged execution (%s) with its parameter values", fmtDur(e.DurationMs)), false
		}
	}
	for _, ex := range captured {
		if fpParam.MatchString(ex.Query) || (maxLen > 0 && len(ex.Query) >= maxLen-1) {
			continue
		}
		return ex.Query, "an execution captured from pg_stat_activity", false
	}
	if fpParam.MatchString(st.Query) {
		return st.Query, "the normalised statement, planned without values (GENERIC_PLAN)", true
	}
	return st.Query, "the normalised statement, which has no placeholders", false
}

// reportExplain explains one statement for a report and lists the tables its
// plan reads.
func (s *Session) reportExplain(ctx context.Context, d *reportData, st StatStatement, logged []SlowLogEntry, captured []QueryExample) *reportPlan {
	if !d.Opts.Explain {
		return nil
	}
	sql, source, generic := planTarget(st, logged, captured, d.MaxQueryLength)
	p := &reportPlan{SQL: strings.TrimSpace(sql), Source: source, Generic: generic}
	switch {
	case st.Database != "" && d.Database != "" && st.Database != d.Database:
		p.Error = fmt.Sprintf("not explained: the statement ran in database %q and this connection is to %q", st.Database, d.Database)
		return p
	case !explainable(sql):
		p.Error = "not explained: EXPLAIN does not accept this kind of statement"
		return p
	case generic && d.ServerMajor < 16:
		p.Error = "not explained: no execution with parameter values was seen, and planning without values needs PostgreSQL 16 or newer (GENERIC_PLAN)"
		return p
	}
	analyze := false
	if d.Opts.Analyze {
		switch {
		case generic:
			p.Note = "EXPLAIN ANALYZE needs real parameter values, and none were seen, so this is the estimated plan only."
		case !readOnly(sql):
			p.Note = "The statement writes, so it was not run with ANALYZE; this is the estimated plan only."
		default:
			analyze = true
		}
	}
	timeout := reportPlainExplainTimeout
	if analyze {
		timeout = time.Duration(d.Opts.AnalyzeTimeoutSeconds * float64(time.Second))
	}
	p.Analyze = analyze
	p.Plan, p.Error = s.explainText(ctx, sql, analyze, generic, timeout)
	if p.Error != "" && analyze {
		p.Error = "EXPLAIN ANALYZE failed: " + p.Error
		// Fall back to the estimated plan so the report still has one.
		if plan, err := s.explainText(ctx, sql, false, false, reportPlainExplainTimeout); err == "" {
			p.Plan, p.Analyze = plan, false
		}
	} else if p.Error != "" {
		p.Error = "EXPLAIN failed: " + p.Error
	}
	if d.Opts.Tables {
		p.Tables = s.planTables(ctx, sql, generic)
	}
	return p
}

// explainText runs EXPLAIN in text form and returns the plan or an error.
func (s *Session) explainText(ctx context.Context, sql string, analyze, generic bool, timeout time.Duration) (string, string) {
	_, script, err := explainScript(sql, analyze, generic, "TEXT")
	if err != nil {
		return "", err.Error()
	}
	conn, release, err := s.acquire(ctx, int(timeout.Milliseconds()))
	if err != nil {
		return "", describeError(err)
	}
	defer release()
	var resp QueryResponse
	err = s.runScript(ctx, conn.Conn(), script, 100000, false, &resp)
	if analyze && conn.Conn().PgConn().TxStatus() != 'I' {
		rbCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _ = conn.Conn().PgConn().Exec(rbCtx, "ROLLBACK").ReadAll()
		cancel()
	}
	if err != nil {
		if isTimeoutPgError(err) {
			return "", fmt.Sprintf("cancelled after %s by statement_timeout", timeout)
		}
		return "", describeError(err)
	}
	for _, r := range resp.Results {
		if len(r.Columns) != 1 || r.Columns[0].Name != "QUERY PLAN" {
			continue
		}
		lines := make([]string, 0, len(r.Rows))
		for _, row := range r.Rows {
			if row[0] != nil {
				lines = append(lines, *row[0])
			}
		}
		return strings.Join(lines, "\n"), ""
	}
	return "", "server returned no plan"
}

// planTables plans the statement again as verbose JSON, which is cheap
// without ANALYZE, and collects the relations it scans.
func (s *Session) planTables(ctx context.Context, sql string, generic bool) []relRef {
	opts := "FORMAT JSON, VERBOSE"
	if generic {
		opts = "GENERIC_PLAN, " + opts
	}
	stmt := strings.TrimRight(strings.TrimSpace(sql), "; \t\r\n")
	conn, release, err := s.acquire(ctx, int(reportPlainExplainTimeout.Milliseconds()))
	if err != nil {
		return nil
	}
	defer release()
	var resp QueryResponse
	if err := s.runScript(ctx, conn.Conn(), "EXPLAIN ("+opts+")\n"+stmt, 10, false, &resp); err != nil {
		return nil
	}
	return relationsInPlan(planText(resp))
}

// relationsInPlan walks an EXPLAIN (FORMAT JSON, VERBOSE) document and
// returns each relation it scans once, in plan order.
func relationsInPlan(planJSON string) []relRef {
	var doc any
	if json.Unmarshal([]byte(planJSON), &doc) != nil {
		return nil
	}
	var out []relRef
	seen := map[relRef]bool{}
	var walk func(v any)
	walk = func(v any) {
		switch n := v.(type) {
		case []any:
			for _, x := range n {
				walk(x)
			}
		case map[string]any:
			name, _ := n["Relation Name"].(string)
			schema, _ := n["Schema"].(string)
			if name != "" && schema != "" && !systemSchema(schema) {
				r := relRef{schema, name}
				if !seen[r] {
					seen[r] = true
					out = append(out, r)
				}
			}
			for _, x := range n {
				walk(x)
			}
		}
	}
	walk(doc)
	return out
}

// systemSchema reports schemas whose tables are the server's own catalogs;
// their definitions say nothing about the workload.
func systemSchema(schema string) bool {
	return schema == "pg_catalog" || schema == "information_schema" || strings.HasPrefix(schema, "pg_toast")
}

// ---- tables ---------------------------------------------------------------

// reportTable is a relation the report's plans read, with what an analyst
// needs to judge its access paths.
type reportTable struct {
	Ref   relRef
	DDL   string
	Error string
	// From pg_class and the statistics views.
	RowsEst, LiveRows, DeadRows int64
	TotalBytes, TableBytes      int64
	SeqScans, IdxScans          int64
	LastAnalyze, LastVacuum     string
	ModsSinceAnalyze            int64
	Indexes                     []reportIndex
	StatsMissing                bool
}

type reportIndex struct {
	Name         string
	Scans, Bytes int64
}

func (s *Session) reportTables(ctx context.Context, refs []relRef) []reportTable {
	out := make([]reportTable, 0, len(refs))
	for _, r := range refs {
		t := reportTable{Ref: r}
		info, err := s.RelationInfo(ctx, r.Schema, r.Name)
		if err != nil {
			t.Error = describeError(err)
			out = append(out, t)
			continue
		}
		t.DDL = info.DDL
		err = s.pool.QueryRow(ctx, `
			select greatest(c.reltuples, 0)::bigint,
			       pg_catalog.pg_total_relation_size(c.oid), pg_catalog.pg_relation_size(c.oid),
			       coalesce(st.n_live_tup, 0), coalesce(st.n_dead_tup, 0),
			       coalesce(st.seq_scan, 0), coalesce(st.idx_scan, 0),
			       coalesce(greatest(st.last_analyze, st.last_autoanalyze)::text, ''),
			       coalesce(greatest(st.last_vacuum, st.last_autovacuum)::text, ''),
			       coalesce(st.n_mod_since_analyze, 0),
			       st.relid is null
			from pg_catalog.pg_class c
			join pg_catalog.pg_namespace n on n.oid = c.relnamespace
			left join pg_catalog.pg_stat_all_tables st on st.relid = c.oid
			where n.nspname = $1 and c.relname = $2`, r.Schema, r.Name).
			Scan(&t.RowsEst, &t.TotalBytes, &t.TableBytes, &t.LiveRows, &t.DeadRows, &t.SeqScans, &t.IdxScans,
				&t.LastAnalyze, &t.LastVacuum, &t.ModsSinceAnalyze, &t.StatsMissing)
		if err != nil {
			t.Error = describeError(err)
		}
		rows, err := s.pool.Query(ctx, `
			select i.indexrelname, coalesce(i.idx_scan, 0), pg_catalog.pg_relation_size(i.indexrelid)
			from pg_catalog.pg_stat_all_indexes i
			where i.schemaname = $1 and i.relname = $2
			order by i.indexrelname`, r.Schema, r.Name)
		if err == nil {
			for rows.Next() {
				var ix reportIndex
				if rows.Scan(&ix.Name, &ix.Scans, &ix.Bytes) == nil {
					t.Indexes = append(t.Indexes, ix)
				}
			}
			rows.Close()
		}
		out = append(out, t)
	}
	return out
}

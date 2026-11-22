package db

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ReportOptions selects which pg_stat_statements rows go into a report.
type ReportOptions struct {
	// TopByTotal is how many statements to take by total execution time;
	// 0 leaves that section out.
	TopByTotal int `json:"topByTotal"`
	// MinMaxSeconds takes every statement whose slowest single run reached
	// this many seconds; 0 leaves that section out.
	MinMaxSeconds float64 `json:"minMaxSeconds"`
	CurrentDBOnly bool    `json:"currentDBOnly"`
	IncludeNested bool    `json:"includeNested"`
	// ReadSlowLog reads the server log for executions with their parameter
	// values. It is best effort: a log that cannot be read is noted.
	ReadSlowLog bool `json:"readSlowLog"`
	// Examples is the most examples written per statement (default 3).
	Examples int `json:"examples"`
	// Explain adds an EXPLAIN plan for each statement, from a real example
	// where one was seen.
	Explain bool `json:"explain"`
	// Analyze uses EXPLAIN ANALYZE for read-only statements with real
	// values: each runs once, inside a transaction that is rolled back.
	Analyze bool `json:"analyze"`
	// AnalyzeTimeoutSeconds bounds each ANALYZE run (default 30).
	AnalyzeTimeoutSeconds float64 `json:"analyzeTimeoutSeconds"`
	// Tables adds the definition, indexes and statistics of every table the
	// plans read. It needs Explain.
	Tables bool `json:"tables"`
}

// ReportQueryID names a running report so CancelQuery can stop it.
const ReportQueryID = "stats-report"

const (
	reportMaxSlowStatements = 200
	reportSlowLogEntries    = 5000
	reportSlowLogBytes      = 32 << 20
)

// reportSettings are the server settings that most change how a plan is
// chosen or how expensive it is to run.
var reportSettings = []string{
	"server_version", "shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem",
	"random_page_cost", "seq_page_cost", "effective_io_concurrency", "default_statistics_target",
	"max_parallel_workers_per_gather", "jit", "plan_cache_mode", "track_io_timing",
	"track_activity_query_size", "log_min_duration_statement",
}

// reportData is everything a report is rendered from, gathered first so the
// rendering can be tested without a server.
type reportData struct {
	Generated  time.Time
	Database   string
	Opts       ReportOptions
	Stats      StatsResponse // totals and reset time; Statements unused
	Settings   [][2]string
	Top        []StatStatement
	Slow       []StatStatement
	SlowCapped bool
	// Captured holds sampler examples by query id.
	Captured       map[string][]QueryExample
	SamplerRunning bool
	SamplerSamples int
	MaxQueryLength int
	// Logged holds slow log executions; LogNote says why there are none.
	Logged  []SlowLogEntry
	LogNote string
	// ServerMajor is the server's major version, such as 17.
	ServerMajor int
	// Plans holds the EXPLAIN output by statKey; Tables the relations those
	// plans read.
	Plans        map[string]*reportPlan
	Tables       []reportTable
	TablesCapped bool
}

// StatsReport builds a Markdown report of the selected statements, with
// example executions, meant to be read by a person or handed to an agent.
func (s *Session) StatsReport(ctx context.Context, opts ReportOptions) (string, error) {
	if opts.TopByTotal <= 0 && opts.MinMaxSeconds <= 0 {
		return "", fmt.Errorf("choose top statements by total time, a max runtime threshold, or both")
	}
	if opts.Examples <= 0 {
		opts.Examples = 3
	}
	if opts.AnalyzeTimeoutSeconds <= 0 {
		opts.AnalyzeTimeoutSeconds = 30
	}
	if !opts.Explain {
		opts.Analyze, opts.Tables = false, false
	}
	ctx, done := s.track(ctx, ReportQueryID)
	defer done()
	stats, err := s.StatStatements(ctx, opts.CurrentDBOnly, 1)
	if err != nil {
		return "", err
	}
	if !stats.Available {
		return "", fmt.Errorf("pg_stat_statements is not available: %s", stats.Message)
	}
	d := reportData{Generated: time.Now(), Opts: opts, Stats: stats, Captured: map[string][]QueryExample{}, Plans: map[string]*reportPlan{}}
	_ = s.pool.QueryRow(ctx, `select current_database(), current_setting('server_version_num')::int / 10000`).Scan(&d.Database, &d.ServerMajor)
	d.Settings = s.reportSettings(ctx)

	cols, err := s.statColumns(ctx)
	if err != nil {
		return "", err
	}
	var conds []string
	if opts.CurrentDBOnly {
		conds = append(conds, currentDBFilter)
	}
	if !opts.IncludeNested && cols.toplevel {
		conds = append(conds, "s.toplevel")
	}
	if opts.TopByTotal > 0 {
		d.Top, err = s.queryStatements(ctx, whereClause(conds), "s."+cols.total+" desc", opts.TopByTotal)
		if err != nil {
			return "", err
		}
	}
	if opts.MinMaxSeconds > 0 {
		slowConds := append(append([]string{}, conds...), "s."+cols.max+" >= $1")
		d.Slow, err = s.queryStatements(ctx, whereClause(slowConds), "s."+cols.max+" desc", reportMaxSlowStatements+1, opts.MinMaxSeconds*1000)
		if err != nil {
			return "", err
		}
		if len(d.Slow) > reportMaxSlowStatements {
			d.Slow, d.SlowCapped = d.Slow[:reportMaxSlowStatements], true
		}
	}

	st := s.Sampling()
	d.SamplerRunning, d.SamplerSamples, d.MaxQueryLength = st.Running, st.Samples, st.MaxQueryLength
	for _, list := range [][]StatStatement{d.Top, d.Slow} {
		for _, row := range list {
			if ex := s.Examples(row.QueryID); len(ex) > 0 {
				d.Captured[row.QueryID] = ex
			}
		}
	}

	if opts.ReadSlowLog {
		logCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		res, err := s.SlowLog(logCtx, reportSlowLogEntries, reportSlowLogBytes)
		cancel()
		switch {
		case err != nil:
			d.LogNote = "The server log could not be read: " + err.Error()
		case !res.Status.Readable || res.Status.Format == "":
			d.LogNote = "The server log could not be read: " + res.Status.Message
		default:
			d.Logged = res.Entries
			if len(d.Logged) == 0 {
				d.LogNote = "The server log was read but held no logged statement durations."
			}
		}
	}
	if opts.Explain {
		var refs []relRef
		seen := map[relRef]bool{}
		for _, st := range uniqueStatements(d) {
			if err := ctx.Err(); err != nil {
				return "", fmt.Errorf("report cancelled")
			}
			logged := loggedFor(st, d.Logged, fingerprint(st.Query))
			p := s.reportExplain(ctx, &d, st, logged, d.Captured[st.QueryID])
			d.Plans[statKey(st)] = p
			for _, r := range p.Tables {
				if !seen[r] {
					seen[r] = true
					refs = append(refs, r)
				}
			}
		}
		if len(refs) > reportMaxTables {
			refs, d.TablesCapped = refs[:reportMaxTables], true
		}
		d.Tables = s.reportTables(ctx, refs)
	}
	if ctx.Err() != nil {
		return "", fmt.Errorf("report cancelled")
	}
	return renderReport(d), nil
}

// uniqueStatements lists each statement once, in the order first listed.
func uniqueStatements(d reportData) []StatStatement {
	var out []StatStatement
	seen := map[string]bool{}
	for _, list := range [][]StatStatement{d.Top, d.Slow} {
		for _, st := range list {
			if k := statKey(st); !seen[k] {
				seen[k] = true
				out = append(out, st)
			}
		}
	}
	return out
}

func whereClause(conds []string) string {
	if len(conds) == 0 {
		return ""
	}
	return "where " + strings.Join(conds, " and ")
}

func (s *Session) reportSettings(ctx context.Context) [][2]string {
	rows, err := s.pool.Query(ctx, `
		select name, current_setting(name)
		from pg_catalog.pg_settings
		where name = any($1)`, reportSettings)
	if err != nil {
		return nil
	}
	defer rows.Close()
	got := map[string]string{}
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			got[k] = v
		}
	}
	var out [][2]string
	for _, k := range reportSettings {
		if v, ok := got[k]; ok {
			out = append(out, [2]string{k, v})
		}
	}
	return out
}

// ---- matching log executions to statements --------------------------------

var (
	fpParam  = regexp.MustCompile(`\$\d+`)
	fpString = regexp.MustCompile(`(?:[eE]|[uU]&)?'(?:[^']|'')*'`)
	fpNumber = regexp.MustCompile(`-?\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b`)
	fpSpace  = regexp.MustCompile(`\s+`)
)

// fingerprint reduces a statement to its shape: placeholders, string and
// numeric constants all become "?", whitespace collapses and case folds. A
// logged statement with literal values and the normalised text
// pg_stat_statements keeps for it then compare equal. It is a heuristic used
// only when the log carries no query id.
func fingerprint(q string) string {
	q = fpParam.ReplaceAllString(q, "?")
	q = fpString.ReplaceAllString(q, "?")
	q = fpNumber.ReplaceAllString(q, "?")
	q = fpSpace.ReplaceAllString(q, " ")
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(q), "; "))
}

// loggedFor returns the logged executions of a statement, slowest first,
// one per distinct statement text with its values.
func loggedFor(st StatStatement, logged []SlowLogEntry, fp string) []SlowLogEntry {
	var out []SlowLogEntry
	seen := map[string]bool{}
	for _, e := range logged {
		if e.Command == "bind" || e.Command == "parse" {
			continue
		}
		match := false
		if e.QueryID != "" && e.QueryID != "0" {
			match = e.QueryID == st.QueryID
		} else {
			match = (e.Database == "" || st.Database == "" || e.Database == st.Database) && fingerprint(e.Query) == fp
		}
		if !match {
			continue
		}
		key := Substitute(e.Query, e.Params)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].DurationMs > out[j].DurationMs })
	return out
}

// ---- rendering ------------------------------------------------------------

func renderReport(d reportData) string {
	var b strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&b, format, args...) }

	// Number each distinct statement once, in the order first listed.
	order := uniqueStatements(d)
	ids := map[string]string{}
	for i, st := range order {
		ids[statKey(st)] = fmt.Sprintf("Q%d", i+1)
	}

	w("# PostgreSQL statement report\n\n")
	w("Generated %s by pginspect from `pg_stat_statements`", d.Generated.Format("2006-01-02 15:04:05 MST"))
	if d.Database != "" {
		w(" while connected to database `%s`", d.Database)
	}
	w(".\n\n")

	w("## How to read this report\n\n")
	w("- Counters are cumulative since %s. Times are execution times in milliseconds unless marked otherwise; planning time is separate and only recorded when `pg_stat_statements.track_planning` is on.\n", orText(d.Stats.StatsReset, "the last reset (time unknown)"))
	w("- `$1`, `$2`, ... in a normalised statement are constants or bind parameters that pg_stat_statements replaced. Example executions below show real values where they were seen.\n")
	w("- Block counts are 8 kB pages. \"Cache hit\" is shared-buffer hits / (hits + reads); reads may still come from the OS page cache. Temp blocks mean a sort, hash or materialise spilled to disk, usually because `work_mem` was too small for it.\n")
	w("- Scope: %s, %s.", map[bool]string{true: "this database only", false: "every database on the server"}[d.Opts.CurrentDBOnly],
		map[bool]string{true: "statements nested in functions included", false: "top-level statements only"}[d.Opts.IncludeNested])
	w(" Server-wide totals for that scope: %s calls, %s total execution time.\n", fmtCount(d.Stats.TotalCalls), fmtDur(d.Stats.TotalMs))
	if d.Opts.Explain {
		w("- Each statement has an EXPLAIN plan in text form, made when this report was generated, so it reflects current statistics and data, not necessarily the plan used when the time was spent. A plan marked ANALYZE really ran once (inside a transaction that was rolled back) and shows actual rows, loops, timing and buffers; the others show estimates only. Planning with real parameter values can differ from the generic plan a prepared statement may use after five executions.\n")
	}
	if d.Opts.Tables {
		w("- \"Tables read by the plans\" at the end gives each table's definition, indexes with their scan counts, size, and when it was last vacuumed and analysed. Scan counts are cumulative since the statistics were last reset.\n")
	}
	w("\n")

	if len(d.Settings) > 0 {
		w("## Server settings\n\n| Setting | Value |\n|---|---|\n")
		for _, kv := range d.Settings {
			w("| %s | %s |\n", kv[0], mdCell(kv[1]))
		}
		w("\n")
	}

	if d.Opts.TopByTotal > 0 {
		w("## Top %d statements by total execution time\n\n", d.Opts.TopByTotal)
		writeSummary(&b, d.Top, ids, d.Stats.TotalMs)
	}
	if d.Opts.MinMaxSeconds > 0 {
		w("## Statements with a single run of %s s or longer\n\n", trimFloat(d.Opts.MinMaxSeconds))
		if d.SlowCapped {
			w("Only the %d with the slowest single run are listed.\n\n", reportMaxSlowStatements)
		}
		writeSummary(&b, d.Slow, ids, d.Stats.TotalMs)
	}

	w("## Where the example executions come from\n\n")
	switch {
	case d.SamplerRunning:
		w("- Live capture from `pg_stat_activity` was on (%s sample%s taken so far).\n", fmtCount(int64(d.SamplerSamples)), plural(d.SamplerSamples))
	case d.SamplerSamples > 0:
		w("- Live capture from `pg_stat_activity` ran earlier (%s sample%s) and is now off.\n", fmtCount(int64(d.SamplerSamples)), plural(d.SamplerSamples))
	default:
		w("- Live capture from `pg_stat_activity` was not run in this session, so no captured examples.\n")
	}
	switch {
	case !d.Opts.ReadSlowLog:
		w("- The server log was not read.\n")
	case d.LogNote != "":
		w("- %s\n", d.LogNote)
	default:
		w("- %s logged executions were read from the server log (statements slower than `log_min_duration_statement`).\n", fmtCount(int64(len(d.Logged))))
	}
	w("\n")

	w("## Statement details\n\n")
	for _, st := range order {
		writeDetail(&b, d, ids[statKey(st)], st)
	}
	if d.Opts.Tables {
		writeTables(&b, d)
	}
	return b.String()
}

func statKey(st StatStatement) string {
	return fmt.Sprintf("%s|%s|%s|%t", st.QueryID, st.User, st.Database, st.TopLevel)
}

func writeSummary(b *strings.Builder, list []StatStatement, ids map[string]string, allMs float64) {
	if len(list) == 0 {
		b.WriteString("No statements match.\n\n")
		return
	}
	b.WriteString("| ID | Total | Share | Calls | Mean | Max | Rows/call | Cache hit | Query |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n")
	for _, st := range list {
		fmt.Fprintf(b, "| %s | %s | %s | %s | %s | %s | %s | %s | `%s` |\n",
			ids[statKey(st)], fmtDur(st.TotalMs), fmtShare(st.TotalMs, allMs), fmtCount(st.Calls),
			fmtDur(st.MeanMs), fmtDur(st.MaxMs), fmtPerCall(st.Rows, st.Calls), fmtHit(st),
			mdCell(truncate(oneLineSQL(st.Query), 90)))
	}
	b.WriteString("\n")
}

func writeDetail(b *strings.Builder, d reportData, id string, st StatStatement) {
	w := func(format string, args ...any) { fmt.Fprintf(b, format, args...) }
	w("### %s\n\n", id)
	nested := ""
	if !st.TopLevel {
		nested = ", nested inside a function or procedure"
	}
	w("queryid `%s`, run as `%s` in database `%s`%s.\n\n", st.QueryID, st.User, st.Database, nested)

	w("| Metric | Value |\n|---|---|\n")
	w("| Calls | %s |\n", fmtCount(st.Calls))
	w("| Total execution | %s (%s of all) |\n", fmtDur(st.TotalMs), fmtShare(st.TotalMs, d.Stats.TotalMs))
	w("| Mean / min / max / stddev | %s / %s / %s / %s |\n", fmtDur(st.MeanMs), fmtDur(st.MinMs), fmtDur(st.MaxMs), fmtDur(st.StddevMs))
	if st.PlanMs > 0 {
		w("| Total planning | %s |\n", fmtDur(st.PlanMs))
	}
	w("| Rows | %s total, %s per call |\n", fmtCount(st.Rows), fmtPerCall(st.Rows, st.Calls))
	w("| Shared blocks | %s hit, %s read, %s dirtied, %s written (cache hit %s) |\n",
		fmtCount(st.SharedHit), fmtCount(st.SharedRead), fmtCount(st.SharedDirtied), fmtCount(st.SharedWritten), orText(fmtHit(st), "n/a"))
	w("| Shared blocks per call | %s hit, %s read |\n", fmtPerCall(st.SharedHit, st.Calls), fmtPerCall(st.SharedRead, st.Calls))
	if st.TempRead > 0 || st.TempWritten > 0 {
		w("| Temp blocks | %s read, %s written |\n", fmtCount(st.TempRead), fmtCount(st.TempWritten))
	}
	if st.IOReadMs > 0 || st.IOWriteMs > 0 {
		w("| I/O time | %s reading, %s writing |\n", fmtDur(st.IOReadMs), fmtDur(st.IOWriteMs))
	}
	if st.WalBytes > 0 {
		w("| WAL | %s bytes |\n", fmtCount(st.WalBytes))
	}
	w("\nNormalised statement:\n\n```sql\n%s\n```\n\n", strings.TrimSpace(st.Query))

	n := d.Opts.Examples
	logged := loggedFor(st, d.Logged, fingerprint(st.Query))
	captured := d.Captured[st.QueryID]
	if len(logged) == 0 && len(captured) == 0 {
		w("No example executions were seen. Turn on \"Capture examples\" while the workload runs, or lower `log_min_duration_statement` so the log records them with their parameters.\n\n")
	}
	if len(logged) > 0 {
		w("Logged executions (slowest first, %d of %d distinct):\n\n", min(n, len(logged)), len(logged))
		for _, e := range logged[:min(n, len(logged))] {
			w("- %s on %s as `%s`", fmtDur(e.DurationMs), orText(fmtTime(e.Time), "unknown time"), orText(e.User, "?"))
			if e.App != "" {
				w(" from `%s`", e.App)
			}
			w("\n")
			if len(e.Params) > 0 {
				w("  - Parameters: %s\n", fmtParams(e.Params))
				w("  - With values substituted:\n\n```sql\n%s\n```\n\n", strings.TrimSpace(Substitute(e.Query, e.Params)))
			} else {
				w("\n```sql\n%s\n```\n\n", strings.TrimSpace(e.Query))
			}
		}
	}
	if len(captured) > 0 {
		w("Captured from `pg_stat_activity` (most recent first, %d of %d distinct):\n\n", min(n, len(captured)), len(captured))
		for _, ex := range captured[:min(n, len(captured))] {
			w("- seen %d time%s, last at %s", ex.Count, plural(ex.Count), fmtTime(ex.LastSeen))
			switch {
			case d.MaxQueryLength > 0 && len(ex.Query) >= d.MaxQueryLength-1:
				w(" (text cut at %d characters by `track_activity_query_size`)", d.MaxQueryLength)
			case fpParam.MatchString(ex.Query):
				w(" (sent with bind parameters; the values are not visible in `pg_stat_activity`)")
			}
			w("\n\n```sql\n%s\n```\n\n", strings.TrimSpace(ex.Query))
		}
	}
	if p := d.Plans[statKey(st)]; p != nil {
		shown := p.SQL == strings.TrimSpace(st.Query) ||
			(len(logged) > 0 && p.SQL == strings.TrimSpace(Substitute(logged[0].Query, logged[0].Params)))
		writePlan(b, p, shown)
	}
}

func writePlan(b *strings.Builder, p *reportPlan, sqlShown bool) {
	w := func(format string, args ...any) { fmt.Fprintf(b, format, args...) }
	switch {
	case p.Plan != "" && p.Analyze:
		w("#### EXPLAIN (ANALYZE, BUFFERS)\n\n")
	case p.Plan != "" && p.Generic:
		w("#### EXPLAIN (GENERIC_PLAN), estimates only\n\n")
	default:
		w("#### EXPLAIN, estimates only\n\n")
	}
	w("Explained: %s.", p.Source)
	if p.Note != "" {
		w(" %s", p.Note)
	}
	w("\n\n")
	if !sqlShown && p.Plan != "" {
		w("```sql\n%s\n```\n\n", p.SQL)
	}
	if p.Error != "" {
		w("%s\n\n", p.Error)
	}
	if p.Plan != "" {
		w("```text\n%s\n```\n\n", strings.TrimRight(p.Plan, "\n"))
	}
	if len(p.Tables) > 0 {
		names := make([]string, len(p.Tables))
		for i, r := range p.Tables {
			names[i] = "`" + r.String() + "`"
		}
		w("Tables read: %s.\n\n", strings.Join(names, ", "))
	}
}

func writeTables(b *strings.Builder, d reportData) {
	w := func(format string, args ...any) { fmt.Fprintf(b, format, args...) }
	w("## Tables read by the plans\n\n")
	if len(d.Tables) == 0 {
		w("No plan named a table.\n\n")
		return
	}
	if d.TablesCapped {
		w("Only the first %d tables are listed.\n\n", reportMaxTables)
	}
	for _, t := range d.Tables {
		w("### %s\n\n", t.Ref.String())
		if t.Error != "" && t.DDL == "" {
			w("Could not be read: %s\n\n", t.Error)
			continue
		}
		w("| Statistic | Value |\n|---|---|\n")
		w("| Estimated rows (pg_class.reltuples) | %s |\n", fmtCount(t.RowsEst))
		if !t.StatsMissing {
			w("| Live / dead rows | %s / %s |\n", fmtCount(t.LiveRows), fmtCount(t.DeadRows))
			w("| Rows changed since last analyse | %s |\n", fmtCount(t.ModsSinceAnalyze))
			w("| Sequential / index scans | %s / %s |\n", fmtCount(t.SeqScans), fmtCount(t.IdxScans))
			w("| Last analysed | %s |\n", orText(t.LastAnalyze, "never"))
			w("| Last vacuumed | %s |\n", orText(t.LastVacuum, "never"))
		}
		w("| Size (table / with indexes and TOAST) | %s / %s |\n", fmtBytes(t.TableBytes), fmtBytes(t.TotalBytes))
		w("\n")
		if len(t.Indexes) > 0 {
			w("| Index | Scans | Size |\n|---|---:|---:|\n")
			for _, ix := range t.Indexes {
				w("| %s | %s | %s |\n", mdCell(ix.Name), fmtCount(ix.Scans), fmtBytes(ix.Bytes))
			}
			w("\n")
		}
		if t.DDL != "" {
			w("```sql\n%s\n```\n\n", strings.TrimRight(t.DDL, "\n"))
		}
	}
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f kB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// ---- formatting -----------------------------------------------------------

func fmtDur(ms float64) string {
	switch {
	case ms >= 3_600_000:
		return fmt.Sprintf("%.2f h", ms/3_600_000)
	case ms >= 60_000:
		return fmt.Sprintf("%.2f min", ms/60_000)
	case ms >= 1000:
		return fmt.Sprintf("%.2f s", ms/1000)
	case ms >= 10:
		return fmt.Sprintf("%.1f ms", ms)
	}
	return fmt.Sprintf("%.3f ms", ms)
}

func fmtCount(n int64) string {
	s := fmt.Sprint(n)
	if n < 0 {
		return s
	}
	var out []byte
	for i := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, s[i])
	}
	return string(out)
}

func fmtPerCall(n, calls int64) string {
	if calls == 0 {
		return "n/a"
	}
	v := float64(n) / float64(calls)
	if v >= 100 {
		return fmtCount(int64(v + 0.5))
	}
	return trimFloat(float64(int64(v*10+0.5)) / 10)
}

func fmtShare(part, whole float64) string {
	if whole <= 0 {
		return "n/a"
	}
	return fmt.Sprintf("%.1f%%", 100*part/whole)
}

func fmtHit(st StatStatement) string {
	total := st.SharedHit + st.SharedRead
	if total == 0 {
		return ""
	}
	return fmt.Sprintf("%.1f%%", 100*float64(st.SharedHit)/float64(total))
}

func fmtTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02 15:04:05 MST")
}

func fmtParams(p map[string]string) string {
	keys := make([]string, 0, len(p))
	for k := range p {
		keys = append(keys, k)
	}
	// $2 before $10.
	sort.Slice(keys, func(i, j int) bool {
		if len(keys[i]) != len(keys[j]) {
			return len(keys[i]) < len(keys[j])
		}
		return keys[i] < keys[j]
	})
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = fmt.Sprintf("`%s = %s`", k, strings.ReplaceAll(p[k], "`", "'"))
	}
	return strings.Join(parts, ", ")
}

func trimFloat(f float64) string {
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.3f", f), "0"), ".")
}

func oneLineSQL(q string) string { return fpSpace.ReplaceAllString(strings.TrimSpace(q), " ") }

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-3]) + "..."
}

// mdCell keeps text from breaking a Markdown table row or code span.
func mdCell(s string) string {
	return strings.NewReplacer("|", "\\|", "`", "'", "\n", " ").Replace(s)
}

func orText(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

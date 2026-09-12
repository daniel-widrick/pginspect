package db

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SlowLogStatus describes whether slow-statement logging can be read.
type SlowLogStatus struct {
	// Readable is true when log files can be listed and read from here.
	Readable bool `json:"readable"`
	// Logging is true when the server writes slow statements to files.
	Logging bool   `json:"logging"`
	Message string `json:"message"`
	// Settings as the server reports them.
	LoggingCollector        string `json:"loggingCollector"`
	LogDestination          string `json:"logDestination"`
	LogMinDurationStatement string `json:"logMinDurationStatement"`
	LogDirectory            string `json:"logDirectory"`
	LogLinePrefix           string `json:"logLinePrefix"`
	LogParameterMaxLength   string `json:"logParameterMaxLength"`
	// Format is "json", "csv" or "text", whichever readable format is newest.
	Format string `json:"format"`
	Files  int    `json:"files"`
}

// SlowLogEntry is one logged statement execution with its real arguments.
type SlowLogEntry struct {
	Time       time.Time `json:"time"`
	User       string    `json:"user"`
	Database   string    `json:"database"`
	PID        int       `json:"pid"`
	DurationMs float64   `json:"durationMs"`
	// Command is "statement" for simple-protocol statements, "execute" for
	// bound executions, "bind" or "parse" for the other protocol phases.
	Command string            `json:"command"`
	Query   string            `json:"query"`
	Params  map[string]string `json:"params,omitempty"` // "$1" -> literal as logged, "NULL" for null
	QueryID string            `json:"queryId"`
	App     string            `json:"app"`
	File    string            `json:"file"`
}

// SlowLogResult is a page of entries plus how much was read to get them.
type SlowLogResult struct {
	Entries   []SlowLogEntry `json:"entries"`
	BytesRead int64          `json:"bytesRead"`
	// Complete is true when every readable log file was consumed.
	Complete bool          `json:"complete"`
	Status   SlowLogStatus `json:"status"`
}

type logFile struct {
	name string
	size int64
	mod  time.Time
}

// SlowLogStatus reports the server's logging settings and whether this
// session may read the log directory.
func (s *Session) SlowLogStatus(ctx context.Context) SlowLogStatus {
	var st SlowLogStatus
	setting := func(name string) string {
		var v *string
		_ = s.pool.QueryRow(ctx, `select current_setting($1, true)`, name).Scan(&v)
		if v == nil {
			return ""
		}
		return *v
	}
	st.LoggingCollector = setting("logging_collector")
	st.LogDestination = setting("log_destination")
	st.LogMinDurationStatement = setting("log_min_duration_statement")
	st.LogDirectory = setting("log_directory")
	st.LogLinePrefix = setting("log_line_prefix")
	st.LogParameterMaxLength = setting("log_parameter_max_length")

	files, err := s.listLogFiles(ctx)
	if err != nil {
		st.Message = "This role cannot list the server log directory: " + err.Error() +
			". Grant pg_monitor (or EXECUTE on pg_ls_logdir and pg_read_file) to the connecting role."
		return st
	}
	st.Files = len(files)
	st.Readable = true
	if st.LoggingCollector != "on" {
		st.Message = "logging_collector is off, so the server writes no log files to read. Set logging_collector = on (needs a restart)."
		return st
	}
	if st.LogMinDurationStatement == "-1" || st.LogMinDurationStatement == "" {
		st.Message = "log_min_duration_statement is -1, so no statement durations are logged. Set it to a threshold such as 500ms (reloadable, no restart)."
	}
	st.Format = pickFormat(files)
	if st.Format == "" {
		if st.Message == "" {
			st.Message = "No log files found yet in " + st.LogDirectory + "."
		}
		return st
	}
	st.Logging = st.LogMinDurationStatement != "-1" && st.LogMinDurationStatement != ""
	if st.Message == "" && st.Format == "text" {
		st.Message = "Reading plain-text logs; add jsonlog (PostgreSQL 15+) or csvlog to log_destination for exact parsing and query ids."
	}
	return st
}

func (s *Session) listLogFiles(ctx context.Context) ([]logFile, error) {
	rows, err := s.pool.Query(ctx, `select name, size, modification from pg_catalog.pg_ls_logdir() order by modification desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []logFile
	for rows.Next() {
		var f logFile
		if err := rows.Scan(&f.name, &f.size, &f.mod); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// pickFormat follows the most recently written file, so a destination
// switched on recently wins over older files in another format. The
// collector's own stderr file is touched at startup, so on a tie within a
// few seconds json and csv are preferred over text.
func pickFormat(files []logFile) string {
	newest := map[string]time.Time{}
	for _, f := range files {
		k := formatOf(f.name)
		if k == "" {
			continue
		}
		if t, ok := newest[k]; !ok || f.mod.After(t) {
			newest[k] = f.mod
		}
	}
	best, bestT := "", time.Time{}
	for _, k := range []string{"json", "csv", "text"} {
		t, ok := newest[k]
		if !ok {
			continue
		}
		// Strictly newer (to the second) wins; equal seconds keep the earlier
		// entry of the priority order.
		if best == "" || t.Truncate(time.Second).After(bestT.Truncate(time.Second)) {
			best, bestT = k, t
		}
	}
	return best
}

func formatOf(name string) string {
	switch {
	case strings.HasSuffix(name, ".json"):
		return "json"
	case strings.HasSuffix(name, ".csv"):
		return "csv"
	case strings.HasSuffix(name, ".log"):
		return "text"
	}
	return ""
}

// SlowLog reads the newest log files, newest first, until limit entries are
// found or maxBytes have been read, and returns them newest first.
func (s *Session) SlowLog(ctx context.Context, limit int, maxBytes int64) (SlowLogResult, error) {
	if limit <= 0 {
		limit = 200
	}
	if maxBytes <= 0 {
		maxBytes = 8 << 20
	}
	res := SlowLogResult{Entries: []SlowLogEntry{}}
	res.Status = s.SlowLogStatus(ctx)
	if !res.Status.Readable || res.Status.Format == "" {
		return res, nil
	}
	files, err := s.listLogFiles(ctx)
	if err != nil {
		return res, err
	}
	dir := res.Status.LogDirectory
	var entries []SlowLogEntry
	remaining := maxBytes
	consumedAll := true
	for _, f := range files {
		if formatOf(f.name) != res.Status.Format {
			continue
		}
		if remaining <= 0 || len(entries) >= limit {
			consumedAll = false
			break
		}
		path := f.name
		if dir != "" {
			path = strings.TrimRight(dir, "/") + "/" + f.name
		}
		length := f.size
		offset := int64(0)
		if length > remaining {
			offset = length - remaining
			length = remaining
			consumedAll = false
		}
		var data string
		if err := s.pool.QueryRow(ctx, `select pg_catalog.pg_read_file($1, $2, $3)`, path, offset, length).Scan(&data); err != nil {
			return res, fmt.Errorf("read %s: %w", path, err)
		}
		remaining -= length
		res.BytesRead += length
		if offset > 0 {
			// Drop the partial first record.
			if i := strings.IndexByte(data, '\n'); i >= 0 {
				data = data[i+1:]
			}
		}
		var parsed []SlowLogEntry
		switch res.Status.Format {
		case "json":
			parsed = parseJSONLog(data)
		case "csv":
			parsed = parseCSVLog(data)
		default:
			parsed = parseTextLog(data)
		}
		for i := range parsed {
			parsed[i].File = f.name
		}
		entries = append(entries, parsed...)
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Time.After(entries[j].Time) })
	if len(entries) > limit {
		entries = entries[:limit]
		consumedAll = false
	}
	res.Entries = entries
	res.Complete = consumedAll
	return res, nil
}

var durationRe = regexp.MustCompile(`^duration: ([0-9.]+) ms(?:\s+(statement|execute|bind|parse)(?: [^:]*)?: (?s)(.*))?$`)

// parseMessage splits "duration: 12.3 ms  execute <unnamed>: SELECT ..." into
// its parts. Messages without a statement (plain duration lines when
// log_statement logged the text separately) yield ok=false.
func parseMessage(msg string) (ms float64, command, query string, ok bool) {
	m := durationRe.FindStringSubmatch(strings.TrimSpace(msg))
	if m == nil || m[2] == "" {
		return 0, "", "", false
	}
	ms, _ = strconv.ParseFloat(m[1], 64)
	return ms, m[2], strings.TrimSpace(m[3]), true
}

// parseParams reads "Parameters: $1 = '7', $2 = 'paid', $3 = NULL" as logged
// by PostgreSQL: values are single-quoted with ” escaping, or NULL.
func parseParams(detail string) map[string]string {
	detail = strings.TrimSpace(detail)
	lower := strings.ToLower(detail)
	i := strings.Index(lower, "parameters:")
	if i < 0 {
		return nil
	}
	rest := strings.TrimSpace(detail[i+len("parameters:"):])
	out := map[string]string{}
	for len(rest) > 0 {
		if !strings.HasPrefix(rest, "$") {
			break
		}
		eq := strings.Index(rest, " = ")
		if eq < 0 {
			break
		}
		name := rest[:eq]
		rest = rest[eq+3:]
		if strings.HasPrefix(rest, "NULL") {
			out[name] = "NULL"
			rest = strings.TrimPrefix(strings.TrimPrefix(rest[4:], ","), " ")
			continue
		}
		if !strings.HasPrefix(rest, "'") {
			break
		}
		// Scan a quoted literal with doubled quotes.
		j := 1
		var b strings.Builder
		for j < len(rest) {
			if rest[j] == '\'' {
				if j+1 < len(rest) && rest[j+1] == '\'' {
					b.WriteByte('\'')
					j += 2
					continue
				}
				break
			}
			b.WriteByte(rest[j])
			j++
		}
		out[name] = "'" + strings.ReplaceAll(b.String(), "'", "''") + "'"
		rest = rest[j+1:]
		rest = strings.TrimPrefix(strings.TrimPrefix(rest, ","), " ")
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseLogTime(s string) time.Time {
	for _, layout := range []string{"2006-01-02 15:04:05.000 MST", "2006-01-02 15:04:05 MST", "2006-01-02 15:04:05.000-07", "2006-01-02 15:04:05-07"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// parseJSONLog handles log_destination = jsonlog (PostgreSQL 15+).
func parseJSONLog(data string) []SlowLogEntry {
	var out []SlowLogEntry
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] != '{' {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(line))
		dec.UseNumber()
		var rec map[string]any
		if err := dec.Decode(&rec); err != nil {
			continue
		}
		str := func(k string) string {
			switch v := rec[k].(type) {
			case string:
				return v
			case json.Number:
				return v.String()
			}
			return ""
		}
		ms, cmd, q, ok := parseMessage(str("message"))
		if !ok {
			continue
		}
		e := SlowLogEntry{Time: parseLogTime(str("timestamp")), User: str("user"), Database: str("dbname"), DurationMs: ms, Command: cmd, Query: q,
			Params: parseParams(str("detail")), QueryID: str("query_id"), App: str("application_name")}
		e.PID, _ = strconv.Atoi(str("pid"))
		if e.QueryID == "0" {
			e.QueryID = ""
		}
		out = append(out, e)
	}
	return out
}

// parseCSVLog handles log_destination = csvlog. Column order is fixed by
// the server; query_id is the 26th column from PostgreSQL 14.
func parseCSVLog(data string) []SlowLogEntry {
	r := csv.NewReader(strings.NewReader(data))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var out []SlowLogEntry
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Skip a damaged (usually the first, partial) record.
			continue
		}
		if len(rec) < 15 {
			continue
		}
		ms, cmd, q, ok := parseMessage(rec[13])
		if !ok {
			continue
		}
		e := SlowLogEntry{Time: parseLogTime(rec[0]), User: rec[1], Database: rec[2], DurationMs: ms, Command: cmd, Query: q, Params: parseParams(rec[14])}
		e.PID, _ = strconv.Atoi(rec[3])
		if len(rec) > 22 {
			e.App = rec[22]
		}
		if len(rec) > 25 && rec[25] != "0" {
			e.QueryID = rec[25]
		}
		out = append(out, e)
	}
	return out
}

var textLineRe = regexp.MustCompile(`^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? [A-Z]+)(?: \[(\d+)\])?(?:[^\n]*?)?(LOG|DETAIL|STATEMENT|ERROR|WARNING|NOTICE|HINT|CONTEXT|FATAL|PANIC):\s+(?s)(.*)$`)

// parseTextLog handles plain stderr logs under the logging collector. The
// prefix is configurable, so this assumes it starts with a timestamp (the
// default %m) and tolerates whatever follows up to the severity. It cannot
// recover the query id.
func parseTextLog(data string) []SlowLogEntry {
	// Records start at a line beginning with a timestamp; continuation lines
	// are indented with a tab.
	var records []string
	var cur strings.Builder
	for _, line := range strings.Split(data, "\n") {
		if len(line) > 19 && line[4] == '-' && line[7] == '-' && line[10] == ' ' && !strings.HasPrefix(line, "\t") {
			if cur.Len() > 0 {
				records = append(records, cur.String())
			}
			cur.Reset()
			cur.WriteString(line)
		} else if cur.Len() > 0 {
			cur.WriteString("\n")
			cur.WriteString(strings.TrimPrefix(line, "\t"))
		}
	}
	if cur.Len() > 0 {
		records = append(records, cur.String())
	}
	var out []SlowLogEntry
	for i, rec := range records {
		m := textLineRe.FindStringSubmatch(rec)
		if m == nil || m[3] != "LOG" {
			continue
		}
		ms, cmd, q, ok := parseMessage(m[4])
		if !ok {
			continue
		}
		e := SlowLogEntry{Time: parseLogTime(m[1]), DurationMs: ms, Command: cmd, Query: q}
		e.PID, _ = strconv.Atoi(m[2])
		// A DETAIL record immediately after carries the parameters.
		if i+1 < len(records) {
			if d := textLineRe.FindStringSubmatch(records[i+1]); d != nil && d[3] == "DETAIL" {
				e.Params = parseParams(d[4])
			}
		}
		out = append(out, e)
	}
	return out
}

// Substitute replaces $n placeholders with the logged literals, leaving
// unknown ones in place.
func Substitute(query string, params map[string]string) string {
	if len(params) == 0 {
		return query
	}
	re := regexp.MustCompile(`\$(\d+)\b`)
	return re.ReplaceAllStringFunc(query, func(m string) string {
		if v, ok := params[m]; ok {
			return v
		}
		return m
	})
}

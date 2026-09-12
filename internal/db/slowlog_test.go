package db

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestParseParams(t *testing.T) {
	p := parseParams("Parameters: $1 = '7', $2 = 'it''s', $3 = NULL, $4 = '{a,b}'")
	if len(p) != 4 || p["$1"] != "'7'" || p["$2"] != "'it''s'" || p["$3"] != "NULL" || p["$4"] != "'{a,b}'" {
		t.Errorf("params: %v", p)
	}
	if parseParams("no parameters here") != nil {
		t.Error("expected nil")
	}
	q := Substitute("select * from t where a = $1 and b = $12 and c = $2", map[string]string{"$1": "'7'", "$2": "NULL"})
	if q != "select * from t where a = '7' and b = $12 and c = NULL" {
		t.Errorf("substitute: %q", q)
	}
}

func TestParseMessage(t *testing.T) {
	ms, cmd, q, ok := parseMessage("duration: 34.927 ms  execute <unnamed>: select 1 where x = $1 ")
	if !ok || ms != 34.927 || cmd != "execute" || q != "select 1 where x = $1" {
		t.Errorf("%v %v %q %q", ok, ms, cmd, q)
	}
	ms, cmd, q, ok = parseMessage("duration: 0.5 ms  statement: select\n2")
	if !ok || cmd != "statement" || q != "select\n2" {
		t.Errorf("%v %v %q %q", ok, ms, cmd, q)
	}
	if _, _, _, ok := parseMessage("duration: 12 ms"); ok {
		t.Error("bare duration should not parse as an entry")
	}
}

func TestParseTextLog(t *testing.T) {
	data := "2026-09-12 23:10:56.412 UTC [59] LOG:  duration: 34.927 ms  execute <unnamed>: select count(*) from shop.orders where customer_id = $1\n" +
		"\tand status = $2\n" +
		"2026-09-12 23:10:56.412 UTC [59] DETAIL:  Parameters: $1 = '7', $2 = 'paid'\n" +
		"2026-09-12 23:10:57.000 UTC [60] LOG:  duration: 1.000 ms  statement: select 1\n"
	es := parseTextLog(data)
	if len(es) != 2 {
		t.Fatalf("entries: %d", len(es))
	}
	if es[0].PID != 59 || es[0].DurationMs != 34.927 || !strings.Contains(es[0].Query, "and status = $2") || es[0].Params["$2"] != "'paid'" {
		t.Errorf("entry0: %+v", es[0])
	}
	if es[1].Command != "statement" || es[1].Params != nil {
		t.Errorf("entry1: %+v", es[1])
	}
}

func TestParseCSVLog(t *testing.T) {
	data := `2026-09-12 23:10:56.412 UTC,"postgres","inspect",59,"[local]",6aa5dc00.3b,3,"SELECT",2026-09-12 23:10:56 UTC,1/2,0,LOG,00000,"duration: 34.927 ms  execute <unnamed>: select count(*) from shop.orders where customer_id = $1 and status = $2 ","Parameters: $1 = '7', $2 = 'paid'",,,,,,,,"psql","client backend",,-3653727160547732294` + "\n"
	es := parseCSVLog(data)
	if len(es) != 1 {
		t.Fatalf("entries: %d", len(es))
	}
	e := es[0]
	if e.User != "postgres" || e.Database != "inspect" || e.PID != 59 || e.QueryID != "-3653727160547732294" || e.App != "psql" || e.Params["$1"] != "'7'" {
		t.Errorf("entry: %+v", e)
	}
}

// TestSlowLogLive needs the test container with logging_collector on and
// log_min_duration_statement = 0; it is skipped otherwise.
func TestSlowLogLive(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	st := s.SlowLogStatus(ctx)
	if !st.Readable || !st.Logging {
		t.Skipf("slow log not available: %s", st.Message)
	}
	// A unique constant proves the entry came from a fresh read of the
	// current log file, not from an older file in another format.
	marker := fmt.Sprintf("select count(*) from app.orders where customer_id = %d", time.Now().UnixNano()%1000000000)
	if r := s.RunQuery(ctx, "sl", marker, 1); r.Error != "" {
		t.Fatal(r.Error)
	}
	time.Sleep(300 * time.Millisecond)
	res, err := s.SlowLog(ctx, 500, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range res.Entries {
		if e.Query == marker {
			found = true
			if e.DurationMs <= 0 || e.Command != "statement" || e.Time.IsZero() {
				t.Errorf("entry: %+v", e)
			}
			// Plain text logs only carry user and database when the prefix
			// includes them; the structured formats always do.
			if st.Format != "text" && e.Database != "inspect" {
				t.Errorf("database missing in %s format: %+v", st.Format, e)
			}
			if st.Format != "text" && e.QueryID == "" {
				t.Errorf("query id missing in %s format", st.Format)
			}
		}
	}
	if !found {
		t.Errorf("marker statement not found among %d entries (format %s)", len(res.Entries), st.Format)
	}
	for i := 1; i < len(res.Entries); i++ {
		if res.Entries[i].Time.After(res.Entries[i-1].Time) {
			t.Error("entries not newest first")
			break
		}
	}
}

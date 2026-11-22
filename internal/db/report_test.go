package db

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestFingerprint(t *testing.T) {
	same := [][2]string{
		{"select * from app.orders where customer_id = $1 and status = $2", "SELECT *  FROM app.orders\n WHERE customer_id = 42 AND status = 'paid';"},
		{"select $1::numeric * 2", "select 1.5e3::numeric * 2"},
		{"select * from t1 where note = $1", "select * from t1 where note = 'it''s'"},
		{"select * from t where x = $1", "select * from t where x = -5"},
	}
	for _, c := range same {
		if a, b := fingerprint(c[0]), fingerprint(c[1]); a != b {
			t.Errorf("want equal:\n%q\n%q", a, b)
		}
	}
	if fingerprint("select * from t1") == fingerprint("select * from t2") {
		t.Error("digits inside identifiers must survive")
	}
}

func reportFixture() reportData {
	slow := StatStatement{QueryID: "-123", Query: "select * from app.orders where status = $1", User: "app", Database: "shop",
		TopLevel: true, Calls: 10, TotalMs: 9000, MeanMs: 900, MaxMs: 4000, Rows: 50, SharedHit: 90, SharedRead: 10}
	busy := StatStatement{QueryID: "77", Query: "select | from x where id = $1", User: "app", Database: "shop",
		TopLevel: true, Calls: 100000, TotalMs: 20000, MeanMs: 0.2, MaxMs: 3, Rows: 100000}
	ts := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	return reportData{
		Generated: ts,
		Database:  "shop",
		Opts:      ReportOptions{TopByTotal: 2, MinMaxSeconds: 1, CurrentDBOnly: true, ReadSlowLog: true, Examples: 2},
		Stats:     StatsResponse{TotalMs: 40000, TotalCalls: 100010},
		Settings:  [][2]string{{"work_mem", "4MB"}},
		Top:       []StatStatement{busy, slow},
		Slow:      []StatStatement{slow},
		Captured: map[string][]QueryExample{
			"77": {{QueryID: "77", Query: "select | from x where id = 9", Count: 3, LastSeen: ts}},
		},
		Logged: []SlowLogEntry{
			// Matched by query id.
			{QueryID: "-123", Query: "select * from app.orders where status = $1", Params: map[string]string{"$1": "'paid'"}, DurationMs: 4000, Command: "execute", Database: "shop"},
			{QueryID: "-123", Query: "select * from app.orders where status = $1", Params: map[string]string{"$1": "'paid'"}, DurationMs: 3000, Command: "execute", Database: "shop"},
			{QueryID: "-123", Query: "select * from app.orders where status = $1", Params: map[string]string{"$1": "'new'"}, DurationMs: 3500, Command: "execute", Database: "shop"},
			// Matched by shape (text log, no query id).
			{Query: "SELECT * FROM app.orders WHERE status = 'void'", DurationMs: 1200, Command: "statement", Database: "shop"},
			// Another database: no match.
			{Query: "select * from app.orders where status = 'x'", DurationMs: 9999, Command: "statement", Database: "other"},
		},
	}
}

func TestRenderReport(t *testing.T) {
	out := renderReport(reportFixture())
	for _, want := range []string{
		"## Top 2 statements by total execution time",
		"## Statements with a single run of 1 s or longer",
		"| Q1 | 20.00 s | 50.0% | 100,000 |",
		"### Q2",
		"`$1 = 'paid'`",
		"select * from app.orders where status = 'paid'",
		"select * from app.orders where status = 'new'",
		"Logged executions (slowest first, 2 of 3 distinct)",
		"| work_mem | 4MB |",
		"select | from x where id = 9",
		"seen 3 times",
		`select \| from x`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	// Q2 appears in both summaries but is detailed once.
	if n := strings.Count(out, "### Q2"); n != 1 {
		t.Errorf("Q2 detailed %d times", n)
	}
	if strings.Contains(out, "### Q3") {
		t.Error("a statement in both sections got a second id")
	}
	if strings.Contains(out, "9999") || strings.Contains(out, "9.99 s") {
		t.Error("execution from another database was matched")
	}
	if strings.ContainsAny(out, "\u2013\u2014") {
		t.Error("report contains a typographic dash")
	}
}

func TestStatsReportLive(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	if r := s.RunQuery(ctx, "rp0", "select pg_sleep(0.05), count(*) from app.orders where status = 'paid'", 1, 0); r.Error != "" {
		t.Fatal(r.Error)
	}
	if _, err := s.StatsReport(ctx, ReportOptions{}); err == nil {
		t.Error("a report with no section selected should be refused")
	}
	out, err := s.StatsReport(ctx, ReportOptions{TopByTotal: 5, MinMaxSeconds: 0.04, CurrentDBOnly: true, ReadSlowLog: true,
		Explain: true, Analyze: true, Tables: true})
	if err != nil {
		if strings.Contains(err.Error(), "not available") {
			t.Skip(err)
		}
		t.Fatal(err)
	}
	if !strings.Contains(out, "## Top 5 statements") || !strings.Contains(out, "pg_sleep") || !strings.Contains(out, "| server_version |") ||
		!strings.Contains(out, "#### EXPLAIN") || !strings.Contains(out, `### "app"."orders"`) {
		t.Errorf("unexpected report:\n%s", out)
	}
}

func TestStatementKinds(t *testing.T) {
	cases := []struct {
		sql                string
		explainable, reads bool
	}{
		{"select 1", true, true},
		{"/* app:orders */ -- note\n  SELECT 1", true, true},
		{"(select 1) union (select 2)", true, true},
		{"with x as (select 1) select * from x", true, true},
		{"with x as (delete from t returning *) select * from x", true, false},
		{"with x as (select 'update' as s) select * from x", true, true},
		{"update t set a = $1", true, false},
		{"insert into t values (1)", true, false},
		{"commit", false, false},
		{"set search_path = app", false, false},
	}
	for _, c := range cases {
		if got := explainable(c.sql); got != c.explainable {
			t.Errorf("explainable(%q) = %v", c.sql, got)
		}
		if got := readOnly(c.sql); got != c.reads {
			t.Errorf("readOnly(%q) = %v", c.sql, got)
		}
	}
}

func TestPlanTarget(t *testing.T) {
	st := StatStatement{Query: "select * from t where a = $1"}
	logged := []SlowLogEntry{
		{Query: "select * from t where a = $1", DurationMs: 900}, // values not logged
		{Query: "select * from t where a = $1", Params: map[string]string{"$1": "'7'"}, DurationMs: 500},
	}
	if sql, _, generic := planTarget(st, logged, nil, 0); sql != "select * from t where a = '7'" || generic {
		t.Errorf("logged: %q %v", sql, generic)
	}
	captured := []QueryExample{{Query: "select * from t where a = $1"}, {Query: "select * from t where a = 9"}}
	if sql, _, _ := planTarget(st, nil, captured, 0); sql != "select * from t where a = 9" {
		t.Errorf("captured: %q", sql)
	}
	if sql, _, generic := planTarget(st, nil, captured[:1], 0); sql != st.Query || !generic {
		t.Errorf("fallback: %q %v", sql, generic)
	}
}

func TestRelationsInPlan(t *testing.T) {
	plan := `[{"Plan": {"Node Type": "Hash Join", "Plans": [
		{"Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "app", "Alias": "o"},
		{"Node Type": "Hash", "Plans": [{"Node Type": "Index Scan", "Relation Name": "customers", "Schema": "app"},
		                               {"Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "app", "Alias": "o2"},
		                               {"Node Type": "Seq Scan", "Relation Name": "pg_class", "Schema": "pg_catalog"}]}]}}]`
	got := relationsInPlan(plan)
	if len(got) != 2 || got[0].String() != "app.orders" && got[0].String() != `"app"."orders"` {
		t.Errorf("relations: %v", got)
	}
}

func TestRenderReportPlans(t *testing.T) {
	d := reportFixture()
	d.Opts.Explain, d.Opts.Analyze, d.Opts.Tables = true, true, true
	slow := d.Slow[0]
	d.Plans = map[string]*reportPlan{
		statKey(slow): {SQL: "select * from app.orders where status = 'paid'", Source: "the slowest logged execution (4.00 s) with its parameter values",
			Analyze: true, Plan: "Seq Scan on orders  (actual time=0.1..3999 rows=50 loops=1)", Tables: []relRef{{"app", "orders"}}},
		statKey(d.Top[0]): {SQL: d.Top[0].Query, Source: "the normalised statement", Generic: true, Error: "EXPLAIN failed: relation \"x\" does not exist"},
	}
	d.Tables = []reportTable{{Ref: relRef{"app", "orders"}, DDL: "CREATE TABLE app.orders (id int);", RowsEst: 1000, LiveRows: 1000,
		Indexes: []reportIndex{{Name: "orders_pkey", Scans: 0, Bytes: 16384}}, TableBytes: 65536, TotalBytes: 90112}}
	out := renderReport(d)
	for _, want := range []string{
		"#### EXPLAIN (ANALYZE, BUFFERS)",
		"actual time=0.1..3999",
		"EXPLAIN failed: relation",
		"## Tables read by the plans",
		"| orders_pkey | 0 | 16.0 kB |",
		"CREATE TABLE app.orders",
		"Last analysed | never",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	// The explained text equals the first logged execution, so it is not repeated.
	if n := strings.Count(out, "select * from app.orders where status = 'paid'"); n != 1 {
		t.Errorf("explained statement written %d times", n)
	}
}

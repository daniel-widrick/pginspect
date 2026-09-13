package db

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"pginspect/internal/config"
)

// These tests need a live server. Point PGINSPECT_TEST_DSN at one, or run the
// docker container from the README (postgres on localhost:5433, db "inspect").
func testSession(t *testing.T) *Session {
	t.Helper()
	p := config.Profile{Host: "localhost", Port: 5433, Database: "inspect", User: "postgres", SSLMode: "disable"}
	pw := "postgres"
	if dsn := os.Getenv("PGINSPECT_TEST_DSN"); dsn != "" {
		t.Skip("PGINSPECT_TEST_DSN parsing not implemented; use defaults")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := Open(ctx, p, pw)
	if err != nil {
		t.Skipf("no test database: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestRunQueryMultiStatement(t *testing.T) {
	s := testSession(t)
	resp := s.RunQuery(context.Background(), "q1", `
		select 1 as a, 'x' as b, null::text as c;
		create temp table tt(id int);
		insert into tt values (1),(2),(3);
		select * from tt order by id;`, 1000, 0)
	if resp.Error != "" {
		t.Fatalf("unexpected error: %s", resp.Error)
	}
	if len(resp.Results) != 4 {
		t.Fatalf("want 4 results, got %d", len(resp.Results))
	}
	r0 := resp.Results[0]
	if len(r0.Columns) != 3 || r0.Columns[0].Name != "a" || r0.Columns[0].Type != "int4" || r0.Columns[1].Type != "text" {
		t.Errorf("columns: %+v", r0.Columns)
	}
	if *r0.Rows[0][0] != "1" || *r0.Rows[0][1] != "x" || r0.Rows[0][2] != nil {
		t.Errorf("row0: %v %v %v", *r0.Rows[0][0], *r0.Rows[0][1], r0.Rows[0][2])
	}
	if resp.Results[2].Command != "INSERT 0 3" || resp.Results[2].RowsAffected != 3 {
		t.Errorf("insert tag: %q affected=%d", resp.Results[2].Command, resp.Results[2].RowsAffected)
	}
	if resp.Results[3].RowCount != 3 {
		t.Errorf("select rows: %d", resp.Results[3].RowCount)
	}
}

func TestRunQueryTruncation(t *testing.T) {
	s := testSession(t)
	resp := s.RunQuery(context.Background(), "q2", `select generate_series(1, 50)`, 10, 0)
	if resp.Error != "" {
		t.Fatal(resp.Error)
	}
	r := resp.Results[0]
	if !r.Truncated || r.RowCount != 50 || len(r.Rows) != 10 {
		t.Errorf("truncated=%v rowCount=%d kept=%d", r.Truncated, r.RowCount, len(r.Rows))
	}
}

func TestRunQueryErrorKeepsPartialResults(t *testing.T) {
	s := testSession(t)
	resp := s.RunQuery(context.Background(), "q3", `select 1; select * from no_such_table; select 2;`, 100, 0)
	if !strings.Contains(resp.Error, "no_such_table") || !strings.Contains(resp.Error, "SQLSTATE 42P01") {
		t.Errorf("error: %q", resp.Error)
	}
	// The simple protocol never starts a result for the failing statement, so
	// only the statements before it are reported.
	if len(resp.Results) != 1 || resp.Results[0].RowCount != 1 {
		t.Errorf("want 1 completed result, got %d", len(resp.Results))
	}
	if resp.Cancelled {
		t.Error("should not report cancelled")
	}
}

func TestCancel(t *testing.T) {
	s := testSession(t)
	done := make(chan QueryResponse, 1)
	go func() { done <- s.RunQuery(context.Background(), "slow", `select pg_sleep(20)`, 10, 0) }()
	time.Sleep(300 * time.Millisecond)
	if !s.Cancel("slow") {
		t.Fatal("query not registered as running")
	}
	select {
	case resp := <-done:
		if !resp.Cancelled {
			t.Errorf("expected cancelled, got error=%q", resp.Error)
		}
		if resp.DurationMs > 5000 {
			t.Errorf("cancel took too long: %dms", resp.DurationMs)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("query did not stop after cancel")
	}
	// The session must still be usable afterwards, on the same connection:
	// a cancel request stops the statement without dropping the socket.
	var before, after int
	_ = s.pool.QueryRow(context.Background(), "select pg_backend_pid()").Scan(&before)
	if resp := s.RunQuery(context.Background(), "after", `select 1`, 10, 0); resp.Error != "" {
		t.Errorf("session broken after cancel: %s", resp.Error)
	}
	_ = s.pool.QueryRow(context.Background(), "select pg_backend_pid()").Scan(&after)
	if s.pool.Stat().TotalConns() == 0 {
		t.Error("pool lost its connections after cancel")
	}
	_ = before
	_ = after
}

func TestTypesAsText(t *testing.T) {
	s := testSession(t)
	resp := s.RunQuery(context.Background(), "q4", `select b, d, iv, n, bl, ip, nul from public.kitchen_sink`, 10, 0)
	if resp.Error != "" {
		t.Fatal(resp.Error)
	}
	row := resp.Results[0].Rows[0]
	want := []string{`\xdeadbeef`, "2024-01-02", "1 day 02:00:00", "1234567.891", "t", "10.0.0.1"}
	for i, w := range want {
		if row[i] == nil || *row[i] != w {
			t.Errorf("col %d: want %q got %v", i, w, row[i])
		}
	}
	if row[6] != nil {
		t.Errorf("nul should be NULL, got %q", *row[6])
	}
	types := resp.Results[0].Columns
	if types[0].Type != "bytea" || types[3].Type != "numeric" || types[5].Type != "inet" {
		t.Errorf("types: %+v", types)
	}
}

func TestIntrospection(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	schemas, err := s.ListSchemas(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(schemas) < 2 || schemas[0].Name != "public" {
		t.Errorf("schemas: %+v", schemas)
	}
	rels, err := s.ListRelations(ctx, "app")
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, r := range rels {
		kinds[r.Name] = r.Kind
	}
	if kinds["customers"] != "table" || kinds["customer_totals"] != "view" {
		t.Errorf("relations: %v", kinds)
	}
	fns, err := s.ListFunctions(ctx, "app")
	if err != nil || len(fns) != 1 || fns[0].Name != "order_count" || fns[0].Arguments != "cid bigint" {
		t.Errorf("functions: %+v err=%v", fns, err)
	}
	def, err := s.FunctionDefinition(ctx, fns[0].OID)
	if err != nil || !strings.HasPrefix(def, "CREATE OR REPLACE FUNCTION app.order_count") {
		t.Errorf("function def: %q err=%v", def, err)
	}

	info, err := s.RelationInfo(ctx, "app", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Columns) != 5 || !info.Columns[0].PrimaryKey || info.Columns[0].Type != "bigint" || !info.Columns[0].NotNull {
		t.Errorf("columns: %+v", info.Columns)
	}
	if !strings.Contains(info.Columns[0].Default, "nextval") {
		t.Errorf("default: %q", info.Columns[0].Default)
	}
	for _, want := range []string{
		`CREATE TABLE "app"."orders" (`,
		`"id" bigint NOT NULL DEFAULT nextval('app.orders_id_seq'::regclass)`,
		`CONSTRAINT "orders_pkey" PRIMARY KEY (id)`,
		`FOREIGN KEY (customer_id) REFERENCES app.customers(id)`,
		`CREATE INDEX orders_customer_idx ON app.orders USING btree (customer_id);`,
	} {
		if !strings.Contains(info.DDL, want) {
			t.Errorf("DDL missing %q:\n%s", want, info.DDL)
		}
	}
	if strings.Contains(info.DDL, "orders_pkey ON") {
		t.Errorf("pk backing index should not be emitted as CREATE INDEX:\n%s", info.DDL)
	}

	view, err := s.RelationInfo(ctx, "app", "customer_totals")
	if err != nil || !strings.HasPrefix(view.DDL, `CREATE VIEW "app"."customer_totals" AS`) || !strings.Contains(view.DDL, "GROUP BY") {
		t.Errorf("view ddl: %q err=%v", view.DDL, err)
	}
}

func TestExplain(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()

	plain := s.Explain(ctx, "e1", "select * from app.orders where customer_id = 1;", false, false, 0)
	if plain.Error != "" || !strings.Contains(plain.Plan, `"Node Type"`) || strings.Contains(plain.Plan, "Actual Rows") {
		t.Errorf("plain explain: err=%q plan=%.120s", plain.Error, plain.Plan)
	}

	analyzed := s.Explain(ctx, "e2", "update app.orders set status = 'paid' where id = 1", true, false, 0)
	if analyzed.Error != "" || !strings.Contains(analyzed.Plan, "Actual Rows") || !strings.Contains(analyzed.Plan, "Execution Time") {
		t.Errorf("analyze explain: err=%q plan=%.120s", analyzed.Error, analyzed.Plan)
	}
	// The update must have been rolled back: the marker value must not persist.
	marker := s.Explain(ctx, "e4", "update app.orders set total = 12345.67 where id = 1", true, false, 0)
	if marker.Error != "" {
		t.Fatal(marker.Error)
	}
	after := s.RunQuery(ctx, "e5", "select total from app.orders where id = 1", 1, 0)
	if after.Error != "" || *after.Results[0].Rows[0][0] == "12345.67" {
		t.Errorf("explain analyze on an update was not rolled back (err=%q)", after.Error)
	}

	bad := s.Explain(ctx, "e6", "select * from nope", true, false, 0)
	if !strings.Contains(bad.Error, "42P01") {
		t.Errorf("bad explain error: %q", bad.Error)
	}
	// Session must be clean afterwards (no aborted transaction on the pooled conn).
	for i := 0; i < 5; i++ {
		if r := s.RunQuery(ctx, "e7", "select 1", 1, 0); r.Error != "" {
			t.Fatalf("session unusable after failed explain analyze: %s", r.Error)
		}
	}
}

func TestStatStatements(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	// Make sure there is at least one distinct statement recorded.
	if r := s.RunQuery(ctx, "st0", "select count(*) from app.orders where status = 'paid'", 1, 0); r.Error != "" {
		t.Fatal(r.Error)
	}
	resp, err := s.StatStatements(ctx, true, 100)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Available {
		t.Skipf("pg_stat_statements not installed: %s", resp.Message)
	}
	if len(resp.Statements) == 0 || resp.TotalCalls == 0 {
		t.Fatalf("no statements returned: %+v", resp)
	}
	found := false
	for _, st := range resp.Statements {
		if strings.Contains(st.Query, "from app.orders where status") {
			found = true
			if st.Calls < 1 || st.Database != "inspect" || st.User == "" || st.TotalMs < 0 {
				t.Errorf("bad row: %+v", st)
			}
		}
	}
	if !found {
		t.Error("recorded statement not found in pg_stat_statements")
	}
	// Query ids are 64-bit and must not be rounded through float64.
	for _, st := range resp.Statements {
		var exact string
		err := s.pool.QueryRow(ctx, `select queryid::text from pg_stat_statements where queryid::text = $1 limit 1`, st.QueryID).Scan(&exact)
		if err != nil || exact != st.QueryID {
			t.Errorf("queryid %q does not exist exactly in pg_stat_statements (err=%v)", st.QueryID, err)
			break
		}
	}
	// Sorted by total time descending.
	for i := 1; i < len(resp.Statements); i++ {
		if resp.Statements[i].TotalMs > resp.Statements[i-1].TotalMs {
			t.Errorf("not sorted at %d", i)
		}
	}
}

func TestExplainGeneric(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	var major int
	if err := s.pool.QueryRow(ctx, "select current_setting('server_version_num')::int / 10000").Scan(&major); err != nil {
		t.Fatal(err)
	}
	if major < 16 {
		t.Skip("GENERIC_PLAN needs PostgreSQL 16")
	}
	resp := s.Explain(ctx, "g1", "select * from app.orders where customer_id = $1 and status = $2", false, true, 0)
	if resp.Error != "" || !resp.Generic || !strings.Contains(resp.Plan, "Index") && !strings.Contains(resp.Plan, "Seq Scan") {
		t.Errorf("generic explain: err=%q plan=%.200s", resp.Error, resp.Plan)
	}
	if strings.Contains(resp.Plan, "Actual Rows") {
		t.Error("generic plan must not execute")
	}
	both := s.Explain(ctx, "g2", "select 1", true, true, 0)
	if both.Error == "" {
		t.Error("analyze+generic should be rejected")
	}
}

func TestActivitySampling(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	if err := s.StartSampling(ctx); err != nil {
		t.Skipf("sampling unsupported: %v", err)
	}
	defer s.StopSampling()
	// Run a statement with a distinctive constant; its backend goes idle with
	// the text still in pg_stat_activity, so the next sample should catch it.
	if r := s.RunQuery(ctx, "smp", "select count(*) from app.orders where customer_id = 424242", 1, 0); r.Error != "" {
		t.Fatal(r.Error)
	}
	var qid string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && qid == "" {
		time.Sleep(250 * time.Millisecond)
		st := s.Sampling()
		for id := range st.Counts {
			for _, ex := range s.Examples(id) {
				if strings.Contains(ex.Query, "424242") {
					qid = id
				}
			}
		}
	}
	if qid == "" {
		t.Fatal("statement with real constant was not captured from pg_stat_activity")
	}
	// The same query_id must match what pg_stat_statements reports.
	stats, err := s.StatStatements(ctx, true, 1000)
	if err != nil {
		t.Fatal(err)
	}
	matched := false
	for _, st := range stats.Statements {
		if st.QueryID == qid && strings.Contains(st.Query, "customer_id = $1") {
			matched = true
		}
	}
	if !matched {
		t.Errorf("query_id %s from pg_stat_activity not found in pg_stat_statements", qid)
	}
	if st := s.Sampling(); !st.Running || st.Samples == 0 || st.MaxQueryLength == 0 {
		t.Errorf("status: %+v", st)
	}

	// Consecutive executions on the same backend, spaced wider than the
	// sample interval, must each be captured: the sampler's own polling must
	// not overwrite the backend's last-query text.
	for _, v := range []int{111, 222, 333} {
		q := fmt.Sprintf("select count(*) from app.orders where customer_id = %d", v)
		if r := s.RunQuery(ctx, "smp", q, 1, 0); r.Error != "" {
			t.Fatal(r.Error)
		}
		time.Sleep(1300 * time.Millisecond)
	}
	got := map[string]bool{}
	for _, ex := range s.Examples(qid) {
		got[ex.Query] = true
	}
	for _, v := range []int{111, 222, 333} {
		if !got[fmt.Sprintf("select count(*) from app.orders where customer_id = %d", v)] {
			t.Errorf("execution with constant %d was not captured; have %v", v, got)
		}
	}
}

func TestStatementTimeout(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	resp := s.RunQuery(ctx, "to1", "select pg_sleep(5)", 10, 300)
	if !resp.TimedOut || resp.Cancelled || !strings.Contains(resp.Error, "statement timeout") {
		t.Errorf("expected timeout, got timedOut=%v cancelled=%v err=%q", resp.TimedOut, resp.Cancelled, resp.Error)
	}
	if resp.DurationMs > 3000 {
		t.Errorf("timeout took %dms", resp.DurationMs)
	}
	// The timeout must not leak into later runs on the pooled connection.
	for i := 0; i < 5; i++ {
		if r := s.RunQuery(ctx, "to2", "select pg_sleep(0.5)", 10, 0); r.Error != "" {
			t.Fatalf("run %d after timeout failed: %s", i, r.Error)
		}
	}
}

func TestLimitStopsPlainSelect(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	start := time.Now()
	resp := s.RunQuery(ctx, "lim", "select g, md5(g::text) from generate_series(1, 50000000) g", 100, 0)
	if resp.Error != "" || !resp.LimitStopped {
		t.Fatalf("err=%q limitStopped=%v", resp.Error, resp.LimitStopped)
	}
	if len(resp.Results) != 1 || len(resp.Results[0].Rows) != 100 || !resp.Results[0].Truncated {
		t.Errorf("results: %+v", resp.Results)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("limit stop took %v; the whole set was streamed", time.Since(start))
	}
	// Still usable afterwards.
	if r := s.RunQuery(ctx, "lim2", "select 1", 1, 0); r.Error != "" {
		t.Errorf("session broken after limit stop: %s", r.Error)
	}
	// A script or a write is never cancelled by the limit.
	r := s.RunQuery(ctx, "lim3", "select 1; select generate_series(1, 5000)", 100, 0)
	if r.Error != "" || r.LimitStopped || r.Results[1].RowCount != 5000 {
		t.Errorf("script: err=%q stopped=%v rows=%d", r.Error, r.LimitStopped, r.Results[1].RowCount)
	}
}

func TestIsPlainSelect(t *testing.T) {
	yes := []string{"select 1", "  SELECT * FROM t;", "-- comment\nselect 1", "/* c */ with x as (select 1) select * from x", "table t", "values (1)"}
	no := []string{"update t set a = 1 returning *", "select 1; select 2", "insert into t select 1", "with d as (delete from t returning *) select * from d", "select * from t for update", "select 1 into tmp", "explain select 1", ""}
	for _, q := range yes {
		if !IsPlainSelect(q) {
			t.Errorf("expected plain select: %q", q)
		}
	}
	for _, q := range no {
		if IsPlainSelect(q) {
			t.Errorf("expected not plain: %q", q)
		}
	}
}

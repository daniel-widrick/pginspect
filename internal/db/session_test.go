package db

import (
	"context"
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
		select * from tt order by id;`, 1000)
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
	resp := s.RunQuery(context.Background(), "q2", `select generate_series(1, 50)`, 10)
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
	resp := s.RunQuery(context.Background(), "q3", `select 1; select * from no_such_table; select 2;`, 100)
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
	go func() { done <- s.RunQuery(context.Background(), "slow", `select pg_sleep(20)`, 10) }()
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
	// The session must still be usable afterwards.
	if resp := s.RunQuery(context.Background(), "after", `select 1`, 10); resp.Error != "" {
		t.Errorf("session broken after cancel: %s", resp.Error)
	}
}

func TestTypesAsText(t *testing.T) {
	s := testSession(t)
	resp := s.RunQuery(context.Background(), "q4", `select b, d, iv, n, bl, ip, nul from public.kitchen_sink`, 10)
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

	plain := s.Explain(ctx, "e1", "select * from app.orders where customer_id = 1;", false, false)
	if plain.Error != "" || !strings.Contains(plain.Plan, `"Node Type"`) || strings.Contains(plain.Plan, "Actual Rows") {
		t.Errorf("plain explain: err=%q plan=%.120s", plain.Error, plain.Plan)
	}

	analyzed := s.Explain(ctx, "e2", "update app.orders set status = 'paid' where id = 1", true, false)
	if analyzed.Error != "" || !strings.Contains(analyzed.Plan, "Actual Rows") || !strings.Contains(analyzed.Plan, "Execution Time") {
		t.Errorf("analyze explain: err=%q plan=%.120s", analyzed.Error, analyzed.Plan)
	}
	// The update must have been rolled back: the marker value must not persist.
	marker := s.Explain(ctx, "e4", "update app.orders set total = 12345.67 where id = 1", true, false)
	if marker.Error != "" {
		t.Fatal(marker.Error)
	}
	after := s.RunQuery(ctx, "e5", "select total from app.orders where id = 1", 1)
	if after.Error != "" || *after.Results[0].Rows[0][0] == "12345.67" {
		t.Errorf("explain analyze on an update was not rolled back (err=%q)", after.Error)
	}

	bad := s.Explain(ctx, "e6", "select * from nope", true, false)
	if !strings.Contains(bad.Error, "42P01") {
		t.Errorf("bad explain error: %q", bad.Error)
	}
	// Session must be clean afterwards (no aborted transaction on the pooled conn).
	for i := 0; i < 5; i++ {
		if r := s.RunQuery(ctx, "e7", "select 1", 1); r.Error != "" {
			t.Fatalf("session unusable after failed explain analyze: %s", r.Error)
		}
	}
}

func TestStatStatements(t *testing.T) {
	s := testSession(t)
	ctx := context.Background()
	// Make sure there is at least one distinct statement recorded.
	if r := s.RunQuery(ctx, "st0", "select count(*) from app.orders where status = 'paid'", 1); r.Error != "" {
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
	resp := s.Explain(ctx, "g1", "select * from app.orders where customer_id = $1 and status = $2", false, true)
	if resp.Error != "" || !resp.Generic || !strings.Contains(resp.Plan, "Index") && !strings.Contains(resp.Plan, "Seq Scan") {
		t.Errorf("generic explain: err=%q plan=%.200s", resp.Error, resp.Plan)
	}
	if strings.Contains(resp.Plan, "Actual Rows") {
		t.Error("generic plan must not execute")
	}
	both := s.Explain(ctx, "g2", "select 1", true, true)
	if both.Error == "" {
		t.Error("analyze+generic should be rejected")
	}
}

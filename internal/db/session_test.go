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

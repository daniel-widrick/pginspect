# pginspect

[![CI](https://github.com/daniel-widrick/pginspect/actions/workflows/ci.yml/badge.svg)](https://github.com/daniel-widrick/pginspect/actions/workflows/ci.yml)

A cross-platform desktop GUI for PostgreSQL, written in Go with a Svelte
frontend, built on [Wails v2](https://wails.io).

## Install

Download the build for your platform from the
[releases page](https://github.com/daniel-widrick/pginspect/releases):

- macOS: `pginspect-darwin-universal.zip` (Apple Silicon and Intel). The app
  is not signed or notarised yet, so the first launch needs
  `xattr -d com.apple.quarantine pginspect.app` or a right-click > Open.
- Windows: `pginspect-windows-amd64.exe`, a single portable executable.
  Needs the WebView2 runtime, which Windows 10/11 already include.
- Linux: `pginspect-linux-amd64.tar.gz`. Needs `libwebkit2gtk-4.1` and GTK 3
  (Ubuntu 22.04+, Fedora 37+, or equivalent).

Features so far:

- Connection manager: saved profiles, passwords in the OS keychain, SSL modes.
- Schema browser: schemas, tables, views, materialized views, foreign tables,
  columns, functions. Double-click a table to query it; the structure view
  shows columns, constraints, indexes and a rendered DDL.
- SQL editor: CodeMirror with PostgreSQL syntax and schema-aware completion.
  Cmd/Ctrl+Enter runs the selection, or the whole editor if nothing is
  selected. Scripts with several statements run in one go.
- Results grid: one tab per statement, sortable columns, NULL rendering,
  copy cell/row, CSV export. Rows are virtualised, so wide or huge results
  do not freeze the window. A row limit and a per-run statement timeout are
  set in the toolbar and remembered; a plain SELECT is cancelled on the
  server as soon as the limit is reached, so `select *` on a huge table
  returns in the time it takes to read the first page. Cancel stops a
  running statement with a server-side cancel request and keeps the
  connection.
- Explain plan viewer: Cmd/Ctrl+E shows the estimated plan, Cmd/Ctrl+Shift+E
  runs EXPLAIN ANALYZE with buffers. The plan is drawn as a tree diagram
  (laid out by [diagram](https://github.com/daniel-widrick/diagram), which
  measures every label before placing boxes so text never overruns), with
  the hottest node in red, edge width following row counts, and a click on
  any node for its full details. A table view shows per-node self time or
  cost and actual versus estimated rows, and both flag misestimates, filters
  that discard most rows, sorts that spill to disk, and hash joins that batch.
  Diagrams can flow top-down or left-to-right; sideways trees use a compact
  one-line node style. Drag to pan, double-click a node to fold its subtree,
  and plans over 100 nodes open folded to their top levels with +N badges.
- Joins view: the tables a plan touched, how each was reached (scan type and
  index), rows and time, and the join conditions between them as a layered
  graph. Joins the planner folded to a constant on both sides are inferred
  and labelled; joins into a costly sequential scan are dashed. Edges are
  routed orthogonally and leave each table from spread ports.
  ANALYZE runs inside a transaction that is always rolled back, so it is safe
  on UPDATE and DELETE.
- Hints: a panel beside every plan that names what to fix and gives the SQL
  to do it. The rules are deterministic and run locally: sequential scans
  whose filter discards most rows (with the CREATE INDEX, including
  expression and trigram indexes, and a range rewrite for casts an index
  cannot serve), indexes that fetch rows a filter then throws away, joins
  that read a whole table to keep a few rows because the join key has no
  index, sorts and hash joins that spill (with the work_mem to set, or the
  index that removes the sort), row estimates that are off (ANALYZE or
  extended statistics on the correlated columns), correlated subqueries run
  per row, and lossy bitmaps, heap fetches, JIT and trigger time. A row-flow
  pass finds where rows are discarded late: a condition evaluated after a
  join instead of at the scan (typically the nullable side of an outer join
  or an OR across tables), a CTE or subquery filtered after being computed,
  a join that multiplies rows a later DISTINCT collapses, cross joins, and
  more tables than join_collapse_limit, where the written order decides the
  plan. The statement text is parsed with the real PostgreSQL parser
  (libpg_query compiled to WebAssembly, loaded on first use) to catch NOT IN
  against a subquery, large OFFSETs, WHERE clauses that turn an outer join
  into an inner one, MATERIALIZED CTEs and SELECT *. Each hint links to its
  plan node; the row-flow table shows rows in and out of every step.
- Query statistics: a pg_stat_statements browser (the sigma button on a
  connection, or Tools > Query Statistics) sorted by total time, with calls,
  mean and max, rows, cache hit ratio, temp spill, I/O time and share of
  total. Expand a row for the full text and block counts, open it in the
  editor, or reset the counters. Works on PG 12 through 17 and explains what
  to configure when the extension is missing. Explain from a row opens the
  statement in a tab with its plan; parameterised statements ask for values
  first, or use EXPLAIN (GENERIC_PLAN) on PostgreSQL 16 and newer.
- Real statement capture: pg_stat_statements only keeps normalised text, so
  while "Capture examples" is on, pginspect polls pg_stat_activity once a
  second over a dedicated connection and keeps the actual statements (with
  their constants) it sees for each query id. A statement is visible while
  it runs and while its backend sits idle afterwards, so even fast queries
  are usually caught on busy systems. Captured examples show under a
  statistics row with one-click Explain. Needs PostgreSQL 14 or newer.
  Two limits come from the server: a client that binds parameters over the
  extended protocol (pgx, JDBC, psycopg and most drivers) shows its statement
  with `$n` placeholders because the values never reach any view, so those
  captures go through the parameter dialog; and text is cut at
  track_activity_query_size (default 1 kB), in which case Explain uses the
  complete normalised statement instead.
- Slow statement log: the stopwatch button on a connection (or Tools > Slow
  Statement Log) reads the server's log files through pg_ls_logdir and
  pg_read_file and lists every logged execution with its duration and, for
  statements a client bound over the extended protocol, the actual parameter
  values. That is the only place PostgreSQL records them. Explain and Explain
  Analyze run the statement with those values in place, so the plan is the
  one production ran. Reads jsonlog, csvlog and plain text; needs
  logging_collector on, a log_min_duration_statement threshold, and a role
  that may read the log directory (pg_monitor, or grants on the two
  functions). jsonlog or csvlog also carries the query id that links an
  execution to its statistics row.
- Light and dark themes following the system setting.

## Layout

```
main.go              Wails bootstrap, native menus
app.go               Methods bound to the frontend (window.go.main.App)
internal/config      Profile store (JSON) and password storage (keychain)
internal/db          Sessions (pgx pools), query execution, catalog introspection
frontend/            Svelte 5 + TypeScript + Vite
  src/lib            Reactive app state, tab and connection logic
  src/components     Sidebar, schema tree, editor, results grid, dialogs
  wailsjs/           Generated bindings (do not edit; wails regenerates them)
```

Queries run over the simple query protocol so multi-statement scripts work
and values arrive as the server's text representation, the same as psql.

## Development

Prerequisites: Go 1.25+, Node 20+, the Wails CLI, and on macOS the Xcode
command line tools (Linux needs webkit2gtk, Windows needs WebView2).

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
wails doctor            # checks platform dependencies
wails dev               # live-reloading dev build
wails build             # production binary in build/bin
go test ./...           # db tests need the container below, otherwise they skip
```

On Ubuntu 24.04 add `-tags webkit2_41` to `wails build` and `wails dev`.

A throwaway database for local testing, with sample data whose plans are
worth looking at (300k orders, 750k order lines, 1M events, skewed keys,
some deliberately missing indexes):

```sh
docker run -d --name pginspect-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=inspect -p 5433:5432 postgres:17 \
  -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=all
docker exec -i pginspect-pg psql -q -U postgres -d inspect < testdata/test-schema.sql
docker exec -i pginspect-pg psql -q -U postgres -d inspect < testdata/seed.sql
```

`test-schema.sql` is the small fixture the Go tests use; `seed.sql` adds the
larger dataset.

`testdata/explain-examples.sql` has queries to try with the plan viewer.

The hint rules have unit tests in `frontend/src/lib/__tests__` (run with
`npm test` in `frontend`). Their fixtures are real EXPLAIN ANALYZE output
from the seed database; `fixtures/queries.txt` lists the query behind each
one, so a fixture can be regenerated with `explain (analyze, buffers,
timing, format json, settings)` against the container.

### Password storage

Passwords go to the OS keychain (`go-keyring`). On macOS an unsigned
development binary changes identity on every rebuild, which makes the
keychain prompt each time. Set `PGINSPECT_NO_KEYRING=1` to store passwords in
a mode 0600 `secrets.json` next to the profiles instead. Profiles live in:

- macOS: `~/Library/Application Support/pginspect/`
- Linux: `~/.config/pginspect/`
- Windows: `%AppData%\pginspect\`

`PGPASSWORD` is also honoured when no password is stored.

## Releasing

CI runs tests, the frontend check and a Linux build on every push. Publishing
a GitHub release (any tag, for example `v0.1.0`) triggers the release
workflow, which builds the macOS universal app, the Windows executable and
the Linux binary, stamps them with the tag, and attaches them to the release.
The same workflow can be run by hand from the Actions tab to get the builds
as workflow artifacts without publishing anything.

## Roadmap

- Inline data editing with SQL preview
- Statement-at-cursor execution
- Virtualised grid for very large result sets
- Per-tab transactions (currently each run is auto-commit on a pooled connection)

# pginspect

A cross-platform desktop GUI for PostgreSQL, written in Go with a Svelte
frontend, built on [Wails v2](https://wails.io).

Features so far:

- Connection manager: saved profiles, passwords in the OS keychain, SSL modes.
- Schema browser: schemas, tables, views, materialized views, foreign tables,
  columns, functions. Double-click a table to query it; the structure view
  shows columns, constraints, indexes and a rendered DDL.
- SQL editor: CodeMirror with PostgreSQL syntax and schema-aware completion.
  Cmd/Ctrl+Enter runs the selection, or the whole editor if nothing is
  selected. Scripts with several statements run in one go.
- Results grid: one tab per statement, sortable columns, NULL rendering,
  row limit, cancel, copy cell/row, CSV export.
- Explain plan viewer: Cmd/Ctrl+E shows the estimated plan, Cmd/Ctrl+Shift+E
  runs EXPLAIN ANALYZE with buffers. The tree shows per-node self time or
  cost, actual versus estimated rows, and flags misestimates, filters that
  discard most rows, sorts that spill to disk, and hash joins that batch.
  ANALYZE runs inside a transaction that is always rolled back, so it is safe
  on UPDATE and DELETE.
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

A throwaway database for local testing, with sample data whose plans are
worth looking at (300k orders, 750k order lines, 1M events, skewed keys,
some deliberately missing indexes):

```sh
docker run -d --name pginspect-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=inspect -p 5433:5432 postgres:17
docker exec -i pginspect-pg psql -q -U postgres -d inspect < testdata/seed.sql
```

`testdata/explain-examples.sql` has queries to try with the plan viewer.

### Password storage

Passwords go to the OS keychain (`go-keyring`). On macOS an unsigned
development binary changes identity on every rebuild, which makes the
keychain prompt each time. Set `PGINSPECT_NO_KEYRING=1` to store passwords in
a mode 0600 `secrets.json` next to the profiles instead. Profiles live in:

- macOS: `~/Library/Application Support/pginspect/`
- Linux: `~/.config/pginspect/`
- Windows: `%AppData%\pginspect\`

`PGPASSWORD` is also honoured when no password is stored.

## Roadmap

- Inline data editing with SQL preview
- Statement-at-cursor execution
- Virtualised grid for very large result sets
- Per-tab transactions (currently each run is auto-commit on a pooled connection)

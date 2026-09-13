package main

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/daniel-widrick/diagram"
	"github.com/daniel-widrick/diagram/layout/layered"
	"github.com/daniel-widrick/diagram/layout/tree"
	"github.com/daniel-widrick/diagram/render/svg"
	"github.com/daniel-widrick/diagram/spec"
	"github.com/daniel-widrick/diagram/text"

	"pginspect/internal/config"
	"pginspect/internal/db"
	"pginspect/internal/update"
)

// ErrPasswordRequired is the exact string the frontend checks for to open a
// password prompt.
const ErrPasswordRequired = "PASSWORD_REQUIRED"

// App holds the state exposed to the frontend through Wails bindings.
type App struct {
	ctx     context.Context
	store   *config.Store
	conns   *db.Manager
	updater *update.Updater
}

// NewApp creates a new App application struct.
func NewApp() *App {
	return &App{conns: db.NewManager()}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	store, err := config.Open()
	if err != nil {
		runtime.LogErrorf(ctx, "open config: %v", err)
		return
	}
	a.store = store

	// Self-update: clean up a previous version, then check weekly in the
	// background; the UI is told through "update:status" events.
	update.Cleanup()
	a.updater = update.New("daniel-widrick/pginspect", version, store.Dir())
	a.updater.OnChange = func(st update.Status) { runtime.EventsEmit(ctx, "update:status", st) }
	if a.updater.Due() {
		go func() {
			cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, _ = a.updater.Check(cctx, false)
		}()
	}
}

func (a *App) shutdown(ctx context.Context) {
	a.conns.CloseAll()
}

func (a *App) requireStore() error {
	if a.store == nil {
		return errors.New("configuration directory is unavailable")
	}
	return nil
}

// ---- profiles -------------------------------------------------------------

// ListProfiles returns saved connection profiles.
func (a *App) ListProfiles() ([]config.Profile, error) {
	if err := a.requireStore(); err != nil {
		return nil, err
	}
	list := a.store.List()
	if list == nil {
		list = []config.Profile{}
	}
	return list, nil
}

// SaveProfile creates or updates a profile. When password is non-empty and
// the profile asks to save it, it goes into the keychain; when SavePassword is
// off any stored password is removed.
func (a *App) SaveProfile(p config.Profile, password string) (config.Profile, error) {
	if err := a.requireStore(); err != nil {
		return p, err
	}
	saved, err := a.store.Save(p)
	if err != nil {
		return p, err
	}
	if saved.SavePassword {
		if password != "" {
			if err := a.store.SetPassword(saved.ID, password); err != nil {
				return saved, fmt.Errorf("profile saved but password could not be stored: %w", err)
			}
		}
	} else if err := a.store.DeletePassword(saved.ID); err != nil {
		runtime.LogWarningf(a.ctx, "delete password: %v", err)
	}
	return saved, nil
}

// DeleteProfile removes a profile, disconnecting it first.
func (a *App) DeleteProfile(id string) error {
	if err := a.requireStore(); err != nil {
		return err
	}
	a.conns.Disconnect(id)
	return a.store.Delete(id)
}

// TestConnection opens a throwaway connection and reports the server version.
func (a *App) TestConnection(p config.Profile, password string) (string, error) {
	if password == "" && p.ID != "" && a.store != nil {
		if pw, ok, _ := a.store.GetPassword(p.ID); ok {
			password = pw
		}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	s, err := db.Open(ctx, p, password)
	if err != nil {
		return "", err
	}
	defer s.Close()
	info, err := s.Info(ctx)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Connected to PostgreSQL %s as %s", info.ServerVersion, info.User), nil
}

// ---- connections ----------------------------------------------------------

// Connect opens a session for the profile. If no password is supplied and none
// is stored, the error text is ErrPasswordRequired so the UI can prompt.
func (a *App) Connect(id string, password string) (db.Info, error) {
	if err := a.requireStore(); err != nil {
		return db.Info{}, err
	}
	p, ok := a.store.Get(id)
	if !ok {
		return db.Info{}, fmt.Errorf("unknown profile %q", id)
	}
	if password == "" {
		pw, found, err := a.store.GetPassword(id)
		if err != nil {
			runtime.LogWarningf(a.ctx, "read password: %v", err)
		}
		if found {
			password = pw
		} else if os.Getenv("PGPASSWORD") != "" {
			password = os.Getenv("PGPASSWORD")
		} else {
			return db.Info{}, errors.New(ErrPasswordRequired)
		}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	s, err := a.conns.Connect(ctx, p, password)
	if err != nil {
		return db.Info{}, err
	}
	return s.Info(ctx)
}

// Disconnect closes the session for the profile.
func (a *App) Disconnect(id string) {
	a.conns.Disconnect(id)
}

// ConnectedIDs lists profiles with an open session.
func (a *App) ConnectedIDs() []string {
	ids := a.conns.ConnectedIDs()
	if ids == nil {
		ids = []string{}
	}
	return ids
}

// ---- catalog --------------------------------------------------------------

func (a *App) catalogCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(a.ctx, 30*time.Second)
}

// ListSchemas returns the schemas of a connected database.
func (a *App) ListSchemas(connID string) ([]db.Schema, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.ListSchemas(ctx)
}

// ListRelations returns tables and views in a schema.
func (a *App) ListRelations(connID, schema string) ([]db.Relation, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.ListRelations(ctx, schema)
}

// ListFunctions returns routines in a schema.
func (a *App) ListFunctions(connID, schema string) ([]db.Routine, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.ListFunctions(ctx, schema)
}

// FunctionDefinition returns the CREATE statement for a routine.
func (a *App) FunctionDefinition(connID string, oid uint32) (string, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return "", err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.FunctionDefinition(ctx, oid)
}

// ListColumns returns the columns of a relation.
func (a *App) ListColumns(connID, schema, name string) ([]db.ColumnInfo, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.ListColumns(ctx, schema, name)
}

// RelationInfo returns structure and DDL for a relation.
func (a *App) RelationInfo(connID, schema, name string) (db.RelationInfo, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return db.RelationInfo{}, err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.RelationInfo(ctx, schema, name)
}

// ---- queries --------------------------------------------------------------

// RunQuery executes SQL on a connection. Errors from the server are reported
// inside the response so partial results survive.
func (a *App) RunQuery(connID, queryID, sql string, maxRows int, timeoutMs int) (db.QueryResponse, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return db.QueryResponse{}, err
	}
	return s.RunQuery(a.ctx, queryID, sql, maxRows, timeoutMs), nil
}

// Explain returns the plan for a statement as EXPLAIN JSON. With analyze the
// statement executes inside a transaction that is rolled back afterwards.
// With generic (PG16+) the statement may contain $n parameters.
func (a *App) Explain(connID, queryID, sql string, analyze, generic bool, timeoutMs int) (db.ExplainResponse, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return db.ExplainResponse{}, err
	}
	return s.Explain(a.ctx, queryID, sql, analyze, generic, timeoutMs), nil
}

// CancelQuery asks the server to abort a running query.
func (a *App) CancelQuery(connID, queryID string) bool {
	s, err := a.conns.Get(connID)
	if err != nil {
		return false
	}
	return s.Cancel(queryID)
}

// ---- statistics -----------------------------------------------------------

// StatStatements reads pg_stat_statements for a connection.
func (a *App) StatStatements(connID string, currentDBOnly bool, limit int) (db.StatsResponse, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return db.StatsResponse{}, err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.StatStatements(ctx, currentDBOnly, limit)
}

// ResetStatStatements clears pg_stat_statements counters.
func (a *App) ResetStatStatements(connID string) error {
	s, err := a.conns.Get(connID)
	if err != nil {
		return err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.ResetStatStatements(ctx)
}

// InstallStatStatements runs CREATE EXTENSION pg_stat_statements.
func (a *App) InstallStatStatements(connID string) error {
	s, err := a.conns.Get(connID)
	if err != nil {
		return err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.InstallStatStatements(ctx)
}

// StartActivitySampling begins collecting real statement texts from
// pg_stat_activity for the connection.
func (a *App) StartActivitySampling(connID string) error {
	s, err := a.conns.Get(connID)
	if err != nil {
		return err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.StartSampling(ctx)
}

// StopActivitySampling pauses collection; examples already seen are kept.
func (a *App) StopActivitySampling(connID string) {
	if s, err := a.conns.Get(connID); err == nil {
		s.StopSampling()
	}
}

// ActivitySampling reports sampler status and example counts per query_id.
func (a *App) ActivitySampling(connID string) (db.SamplingStatus, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return db.SamplingStatus{}, err
	}
	return s.Sampling(), nil
}

// QueryExamples returns real statement texts seen for a query_id.
func (a *App) QueryExamples(connID, queryID string) ([]db.QueryExample, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return nil, err
	}
	ex := s.Examples(queryID)
	if ex == nil {
		ex = []db.QueryExample{}
	}
	return ex, nil
}

// ---- export ---------------------------------------------------------------

// ExportCSV prompts for a file and writes the given result to it. NULL cells
// are written as empty fields. Returns the chosen path, or "" if cancelled.
func (a *App) ExportCSV(columns []string, rows [][]*string, suggestedName string) (string, error) {
	if suggestedName == "" {
		suggestedName = "results.csv"
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export CSV",
		DefaultFilename: suggestedName,
		Filters:         []runtime.FileFilter{{DisplayName: "CSV files", Pattern: "*.csv"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	if err := w.Write(columns); err != nil {
		return "", err
	}
	rec := make([]string, len(columns))
	for _, row := range rows {
		for i := range rec {
			rec[i] = ""
			if i < len(row) && row[i] != nil {
				rec[i] = *row[i]
			}
		}
		if err := w.Write(rec); err != nil {
			return "", err
		}
	}
	w.Flush()
	return path, w.Error()
}

// UpdateStatus reports the self-updater's state.
func (a *App) UpdateStatus() update.Status {
	if a.updater == nil {
		return update.Status{Current: version, State: "unsupported"}
	}
	return a.updater.Status()
}

// CheckForUpdate asks GitHub for a newer release now. With force, a version
// the user skipped is offered again.
func (a *App) CheckForUpdate(force bool) (update.Status, error) {
	if a.updater == nil {
		return update.Status{Current: version, State: "unsupported"}, nil
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.updater.Check(ctx, force)
}

// SkipUpdate hides the offered version until a newer one appears.
func (a *App) SkipUpdate(tag string) {
	if a.updater != nil {
		a.updater.Skip(tag)
	}
}

// ApplyUpdate downloads, verifies and installs the offered release, starts
// the new version and quits this one.
func (a *App) ApplyUpdate() error {
	if a.updater == nil {
		return fmt.Errorf("this build cannot update itself")
	}
	if err := a.updater.Apply(a.ctx); err != nil {
		return err
	}
	a.conns.CloseAll()
	go func() {
		time.Sleep(500 * time.Millisecond)
		runtime.Quit(a.ctx)
	}()
	return nil
}

// Version returns the build version ("dev" for local builds).
func (a *App) Version() string {
	return version
}

// ---- slow log -------------------------------------------------------------

// SlowLogStatus reports whether the server's statement log can be read.
func (a *App) SlowLogStatus(connID string) (db.SlowLogStatus, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return db.SlowLogStatus{}, err
	}
	ctx, cancel := a.catalogCtx()
	defer cancel()
	return s.SlowLogStatus(ctx), nil
}

// SlowLog reads logged statement executions, newest first.
func (a *App) SlowLog(connID string, limit int, maxBytes int64) (db.SlowLogResult, error) {
	s, err := a.conns.Get(connID)
	if err != nil {
		return db.SlowLogResult{}, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	return s.SlowLog(ctx, limit, maxBytes)
}

// ---- diagrams -------------------------------------------------------------

// RenderDiagram lays out a graph with the diagram library and returns an
// inline SVG that uses the app's CSS variables for colour. layout is
// "tree" or "layered". The frontend builds the graph (for example from a
// parsed EXPLAIN plan) and injects the result. Labels are measured with Go
// Mono, which the frontend also loads, so text fits its boxes exactly.
func (a *App) RenderDiagram(graph spec.Graph, layout string, title string) (string, error) {
	g, err := graph.Graph()
	if err != nil {
		return "", err
	}
	opts := diagram.Options{Measurer: diagramFonts, Styles: text.DefaultStyles()}
	var l *diagram.Layout
	switch layout {
	case "", "tree":
		l, err = tree.Layout(g, opts)
	case "layered":
		l, err = layered.Layout(g, opts)
	default:
		err = fmt.Errorf("unknown layout %q", layout)
	}
	if err != nil {
		return "", err
	}
	th := svg.Tokens()
	th.Background = "transparent"
	th.Node = svg.KindStyle{Fill: "var(--bg-2)", Stroke: "var(--border)", Text: "var(--fg)", TextMuted: "var(--fg-2)"}
	th.Edge = "var(--fg-2)"
	th.EdgeLabel = "var(--fg-2)"
	th.BarTrack = "var(--bg-3)"
	th.BarFill = "var(--accent)"
	th.Kinds["hot"] = svg.KindStyle{Fill: "var(--danger)", Stroke: "var(--danger)", Text: "#ffffff", TextMuted: "rgba(255,255,255,0.85)"}
	th.Kinds["warm"] = svg.KindStyle{Fill: "color-mix(in srgb, var(--warn) 25%, var(--bg-2))", Stroke: "var(--warn)"}
	th.Kinds["weak"] = svg.KindStyle{Stroke: "var(--danger)", StrokeDash: "6 4"}
	th.FontMono = `"Go Mono", ui-monospace, Menlo, monospace`
	return svg.Render(l, svg.Options{Theme: th, Styles: opts.Styles, Title: title, Inline: true}), nil
}

// diagramFonts is shared: parsing the embedded fonts once is enough.
var diagramFonts = text.NewGoFonts()

// ConfigDir tells the UI where profiles are stored.
func (a *App) ConfigDir() string {
	if a.store == nil {
		return ""
	}
	return a.store.Dir()
}

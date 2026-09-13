package db

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Schema is a namespace in the database.
type Schema struct {
	Name    string `json:"name"`
	Comment string `json:"comment"`
}

// Relation is a table, view, materialized view, foreign table or partitioned table.
type Relation struct {
	Schema  string `json:"schema"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // table, view, matview, foreign, partitioned
	Comment string `json:"comment"`
	RowsEst int64  `json:"rowsEst"`
}

// ColumnInfo describes a table column.
type ColumnInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	NotNull    bool   `json:"notNull"`
	Default    string `json:"default"`
	PrimaryKey bool   `json:"primaryKey"`
	Comment    string `json:"comment"`
}

// IndexInfo is one index on a table.
type IndexInfo struct {
	Name       string `json:"name"`
	Definition string `json:"definition"`
}

// ConstraintInfo is one constraint on a table.
type ConstraintInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"` // p, f, u, c, x
	Definition string `json:"definition"`
}

// Routine is a function, procedure or aggregate in a schema.
type Routine struct {
	Schema    string `json:"schema"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	Returns   string `json:"returns"`
	Kind      string `json:"kind"` // function, procedure, aggregate, window
	OID       uint32 `json:"oid"`
}

// RelationInfo is everything the structure view needs for one relation.
type RelationInfo struct {
	Relation    Relation         `json:"relation"`
	Columns     []ColumnInfo     `json:"columns"`
	Indexes     []IndexInfo      `json:"indexes"`
	Constraints []ConstraintInfo `json:"constraints"`
	DDL         string           `json:"ddl"`
}

var relkindNames = map[string]string{
	"r": "table", "p": "partitioned", "v": "view", "m": "matview", "f": "foreign",
}

// ListSchemas returns user schemas, public first.
func (s *Session) ListSchemas(ctx context.Context) ([]Schema, error) {
	rows, err := s.pool.Query(ctx, `
		select n.nspname, coalesce(pg_catalog.obj_description(n.oid, 'pg_namespace'), '')
		from pg_catalog.pg_namespace n
		where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
		  and n.nspname not like 'pg\_temp\_%' and n.nspname not like 'pg\_toast\_temp\_%'
		order by (n.nspname = 'public') desc, n.nspname`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Schema])
}

// ListRelations returns tables and views in a schema.
func (s *Session) ListRelations(ctx context.Context, schema string) ([]Relation, error) {
	rows, err := s.pool.Query(ctx, `
		select n.nspname, c.relname, c.relkind::text,
		       coalesce(pg_catalog.obj_description(c.oid, 'pg_class'), ''),
		       greatest(c.reltuples, 0)::bigint
		from pg_catalog.pg_class c
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')
		order by c.relname`, schema)
	if err != nil {
		return nil, err
	}
	rels, err := pgx.CollectRows(rows, pgx.RowToStructByPos[Relation])
	if err != nil {
		return nil, err
	}
	for i := range rels {
		rels[i].Kind = relkindNames[rels[i].Kind]
	}
	return rels, nil
}

// ListFunctions returns routines in a schema.
func (s *Session) ListFunctions(ctx context.Context, schema string) ([]Routine, error) {
	rows, err := s.pool.Query(ctx, `
		select n.nspname, p.proname,
		       pg_catalog.pg_get_function_identity_arguments(p.oid),
		       coalesce(pg_catalog.pg_get_function_result(p.oid), ''),
		       case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window' else 'function' end,
		       p.oid
		from pg_catalog.pg_proc p
		join pg_catalog.pg_namespace n on n.oid = p.pronamespace
		where n.nspname = $1
		order by p.proname, 3`, schema)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Routine])
}

// FunctionDefinition returns the full CREATE statement for a routine.
func (s *Session) FunctionDefinition(ctx context.Context, oid uint32) (string, error) {
	var def string
	err := s.pool.QueryRow(ctx, `select pg_catalog.pg_get_functiondef($1::oid)`, oid).Scan(&def)
	return def, err
}

// ListColumns returns the columns of a relation.
func (s *Session) ListColumns(ctx context.Context, schema, name string) ([]ColumnInfo, error) {
	rows, err := s.pool.Query(ctx, `
		select a.attname,
		       pg_catalog.format_type(a.atttypid, a.atttypmod),
		       a.attnotnull,
		       coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''),
		       exists (select 1 from pg_catalog.pg_constraint con
		               where con.conrelid = a.attrelid and con.contype = 'p' and a.attnum = any(con.conkey)),
		       coalesce(pg_catalog.col_description(a.attrelid, a.attnum), '')
		from pg_catalog.pg_attribute a
		join pg_catalog.pg_class c on c.oid = a.attrelid
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
		where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
		order by a.attnum`, schema, name)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[ColumnInfo])
}

// TableColumns describes a relation found by bare name, for resolving the
// tables a plan mentions to their schema and column list.
type TableColumns struct {
	Schema  string   `json:"schema"`
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
}

// ResolveTables finds every relation with one of the given names, in any
// schema the user can see, with its columns. A name that appears in more
// than one schema comes back more than once.
func (s *Session) ResolveTables(ctx context.Context, names []string) ([]TableColumns, error) {
	rows, err := s.pool.Query(ctx, `
		select n.nspname, c.relname,
		       coalesce((select array_agg(a.attname::text order by a.attnum)
		                 from pg_catalog.pg_attribute a
		                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '{}')
		from pg_catalog.pg_class c
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		where c.relname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'f')
		  and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
		order by n.nspname, c.relname`, names)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[TableColumns])
	if out == nil {
		out = []TableColumns{}
	}
	return out, err
}

// RelationInfo gathers columns, indexes, constraints and a DDL rendering.
func (s *Session) RelationInfo(ctx context.Context, schema, name string) (RelationInfo, error) {
	var info RelationInfo
	var kind string
	err := s.pool.QueryRow(ctx, `
		select n.nspname, c.relname, c.relkind::text,
		       coalesce(pg_catalog.obj_description(c.oid, 'pg_class'), ''),
		       greatest(c.reltuples, 0)::bigint
		from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, schema, name).
		Scan(&info.Relation.Schema, &info.Relation.Name, &kind, &info.Relation.Comment, &info.Relation.RowsEst)
	if err != nil {
		return info, err
	}
	info.Relation.Kind = relkindNames[kind]

	if info.Columns, err = s.ListColumns(ctx, schema, name); err != nil {
		return info, err
	}

	rows, err := s.pool.Query(ctx, `
		select indexname, indexdef from pg_catalog.pg_indexes
		where schemaname = $1 and tablename = $2 order by indexname`, schema, name)
	if err != nil {
		return info, err
	}
	if info.Indexes, err = pgx.CollectRows(rows, pgx.RowToStructByPos[IndexInfo]); err != nil {
		return info, err
	}

	rows, err = s.pool.Query(ctx, `
		select con.conname, con.contype::text, pg_catalog.pg_get_constraintdef(con.oid, true)
		from pg_catalog.pg_constraint con
		join pg_catalog.pg_class c on c.oid = con.conrelid
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2
		order by con.contype, con.conname`, schema, name)
	if err != nil {
		return info, err
	}
	if info.Constraints, err = pgx.CollectRows(rows, pgx.RowToStructByPos[ConstraintInfo]); err != nil {
		return info, err
	}

	switch kind {
	case "v", "m":
		var def string
		if err := s.pool.QueryRow(ctx,
			`select pg_catalog.pg_get_viewdef(($1 || '.' || $2)::regclass, true)`,
			QuoteIdent(schema), QuoteIdent(name)).Scan(&def); err != nil {
			return info, err
		}
		keyword := "VIEW"
		if kind == "m" {
			keyword = "MATERIALIZED VIEW"
		}
		info.DDL = fmt.Sprintf("CREATE %s %s AS\n%s", keyword, QualifiedName(schema, name), strings.TrimSpace(def))
	default:
		info.DDL = renderTableDDL(info)
	}
	return info, nil
}

// renderTableDDL builds a CREATE TABLE statement from catalog data. Postgres
// has no server-side equivalent, so this is a faithful-enough approximation.
func renderTableDDL(info RelationInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s (\n", QualifiedName(info.Relation.Schema, info.Relation.Name))
	var lines []string
	for _, c := range info.Columns {
		line := "    " + QuoteIdent(c.Name) + " " + c.Type
		if c.NotNull {
			line += " NOT NULL"
		}
		if c.Default != "" {
			line += " DEFAULT " + c.Default
		}
		lines = append(lines, line)
	}
	for _, con := range info.Constraints {
		lines = append(lines, "    CONSTRAINT "+QuoteIdent(con.Name)+" "+con.Definition)
	}
	b.WriteString(strings.Join(lines, ",\n"))
	b.WriteString("\n);\n")
	constrained := map[string]bool{}
	for _, con := range info.Constraints {
		constrained[con.Name] = true
	}
	for _, ix := range info.Indexes {
		if constrained[ix.Name] {
			continue // backing index of a PK/unique constraint
		}
		b.WriteString("\n" + ix.Definition + ";\n")
	}
	if info.Relation.Comment != "" {
		fmt.Fprintf(&b, "\nCOMMENT ON TABLE %s IS %s;\n",
			QualifiedName(info.Relation.Schema, info.Relation.Name), QuoteLiteral(info.Relation.Comment))
	}
	for _, c := range info.Columns {
		if c.Comment != "" {
			fmt.Fprintf(&b, "COMMENT ON COLUMN %s.%s IS %s;\n",
				QualifiedName(info.Relation.Schema, info.Relation.Name), QuoteIdent(c.Name), QuoteLiteral(c.Comment))
		}
	}
	return b.String()
}

// QuoteIdent double-quotes an identifier.
func QuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// QuoteLiteral single-quotes a string literal.
func QuoteLiteral(s string) string {
	return `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
}

// QualifiedName returns schema.name with both parts quoted.
func QualifiedName(schema, name string) string {
	return QuoteIdent(schema) + "." + QuoteIdent(name)
}

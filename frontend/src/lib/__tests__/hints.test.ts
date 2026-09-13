import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parsePlan } from '../plan'
import { analyzePlan, textPredicates, type Hint } from '../hints'
import { sqlFacts, deparse } from '../sqlast'
import { initParser, parseSql } from '../pgquery'

const dir = join(__dirname, 'fixtures')
const wasm = readFileSync(join(__dirname, '../../../node_modules/libpg-query/wasm/libpg-query.wasm'))

// Column lists for the seed schema, standing in for the app's schema cache.
const columns = (schema: string | null, table: string): string[] | undefined => ({
  orders: ['id', 'customer_id', 'status', 'placed_at', 'shipped_at', 'total', 'note'],
  customers: ['id', 'email', 'full_name', 'country', 'tier', 'signed_up_at', 'attributes'],
  products: ['id', 'sku', 'name', 'category_id', 'price', 'active', 'tags'],
  order_items: ['order_id', 'line', 'product_id', 'quantity', 'unit_price'],
  events: ['id', 'customer_id', 'kind', 'occurred_at', 'payload'],
  countries: ['code', 'name', 'region'],
  categories: ['id', 'name', 'parent_id'],
} as Record<string, string[]>)[table]

async function analyze(name: string, withSql = true) {
  const plan = parsePlan(readFileSync(join(dir, name + '.json'), 'utf8'))
  const sql = readFileSync(join(dir, name + '.sql'), 'utf8')
  const facts = withSql ? sqlFacts(await parseSql(sql), columns) : null
  return { plan, facts, ...analyzePlan(plan, { facts, serverMajor: 17, schemaOf: t => columns(null, t) ? 'shop' : null }) }
}

const ids = (hints: Hint[]) => hints.map(h => h.id)
const byId = (hints: Hint[], id: string) => hints.find(h => h.id === id)!

beforeAll(async () => { await initParser({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }) })

describe('parser', () => {
  it('parses and deparses expressions', async () => {
    const ast = await parseSql("select 1 from t where lower(a.name) like '%x' and b::date = '2025-01-01' and c in (1, 2)")
    const w = (ast.stmts![0] as any).stmt.SelectStmt.whereClause
    expect(deparse(w)).toBe("(lower(a.name) LIKE '%x' AND (b)::date = '2025-01-01' AND c IN (1, 2))")
  })
  it('reports syntax errors with a position', async () => {
    await expect(parseSql('select from where')).rejects.toThrow(/syntax error/)
  })
})

describe('sql facts', () => {
  it('collects relations, predicates and shapes', async () => {
    const f = sqlFacts(await parseSql(readFileSync(join(dir, 'late_filter.sql'), 'utf8')), columns)!
    expect(f.relations.map(r => `${r.alias}:${r.name}:${r.nullable}`)).toEqual(['c:customers:false', 'o:orders:true'])
    expect(f.predicates.map(p => p.text)).toEqual(["coalesce(o.status, 'none') <> 'shipped'", 'o.customer_id = c.id'])
    expect(f.predicates[0].wrapped).toBe('func')
    expect(f.predicates[1].joinKey).toBe(true)
    expect(f.groupBy).toBe(true)
  })
  it('finds NOT IN, OFFSET, DISTINCT, star and CTEs', async () => {
    const a = sqlFacts(await parseSql(readFileSync(join(dir, 'not_in.sql'), 'utf8')), columns)!
    expect(a.notInSubquery.length).toBe(1)
    expect(a.selectStar).toBe(true)
    const b = sqlFacts(await parseSql(readFileSync(join(dir, 'offset_page.sql'), 'utf8')), columns)!
    expect(b.offset).toBe(100000)
    const c = sqlFacts(await parseSql(readFileSync(join(dir, 'fanout_distinct.sql'), 'utf8')), columns)!
    expect(c.distinct).toBe(true)
    const d = sqlFacts(await parseSql(readFileSync(join(dir, 'cte_fence.sql'), 'utf8')), columns)!
    expect(d.ctes).toEqual([{ name: 'recent', materialized: 'always', refs: 1 }])
  })
  it('resolves unqualified columns through the schema map', async () => {
    const f = sqlFacts(await parseSql('select * from shop.orders o join shop.customers c on c.id = o.customer_id where status = $1 and tier = $2'), columns)!
    expect(f.predicates.filter(p => !p.joinKey).map(p => `${p.cols[0].alias}.${p.cols[0].column}`)).toEqual(['o.status', 'c.tier'])
  })
  it('flags WHERE on the nullable side', async () => {
    const f = sqlFacts(await parseSql(readFileSync(join(dir, 'outer_where.sql'), 'utf8')), columns)!
    expect(f.outerWhere).toEqual([{ alias: 'o', text: "o.status = 'new'" }])
  })
})

describe('text predicates', () => {
  it('reads plan filter text', () => {
    const p = textPredicates("((status = 'paid'::text) AND (total > '900'::numeric) AND (shipped_at IS NULL))", 'orders')
    expect(p.map(x => `${x.col.column} ${x.op}`)).toEqual(['status =', 'total >', 'shipped_at IS NULL'])
  })
  it('sees through casts and functions', () => {
    expect(textPredicates("((placed_at)::date = '2025-06-01'::date)", null)[0]).toMatchObject({ wrapped: 'cast', exprSql: '(placed_at)::date' })
    expect(textPredicates("(lower(email) = 'x'::text)", null)[0]).toMatchObject({ wrapped: 'func', exprSql: 'lower(email)' })
    expect(textPredicates("((name)::text = 'x'::text)", null)[0]).toMatchObject({ wrapped: null, col: { column: 'name' } })
  })
  it('separates own and foreign columns', () => {
    const p = textPredicates('(product_id = p.id)', 'oi')
    expect(p).toHaveLength(2)
    expect(p[0]).toMatchObject({ col: { column: 'product_id' }, foreign: false, op: 'JOIN' })
    expect(p[1]).toMatchObject({ col: { alias: 'p', column: 'id' }, foreign: true })
  })
  it('ignores subplan references and keywords', () => {
    expect(textPredicates('(NOT (ANY (id = (hashed SubPlan 1).col1)))', 'c').map(x => x.col.column)).toEqual(['id'])
  })
})

describe('hints', () => {
  it('seq scan with a selective filter suggests an index', async () => {
    const { hints } = await analyze('seqscan_filter')
    const h = byId(hints, 'seq-scan-index')
    expect(h.fix).toBe('create index concurrently on shop.orders (note);')
    expect(h.severity).toBe('high')
  })
  it('works from the plan alone in estimate mode', async () => {
    const { hints } = await analyze('seqscan_filter_est', false)
    expect(byId(hints, 'seq-scan-index').fix).toBe('create index concurrently on shop.orders (note);')
  })
  it('index then filter suggests extending the index', async () => {
    const { hints } = await analyze('index_filter')
    expect(byId(hints, 'extend-index').fix).toBe('create index concurrently on shop.orders (status, total);')
  })
  it('missing join-key index on the big side', async () => {
    const { hints } = await analyze('hash_full_table')
    expect(byId(hints, 'seq-scan-index').fix).toBe('create index concurrently on shop.order_items (product_id);')
    const est = await analyze('nl_missing_index_est')
    expect(byId(est.hints, 'drive-from-big-side').fix).toBe('create index concurrently on shop.order_items (product_id);')
    const real = await analyze('nl_missing_index')
    expect(byId(real.hints, 'drive-from-big-side').severity).toBe('high')
  })
  it('late filter on the nullable side of an outer join', async () => {
    const { hints, flow } = await analyze('late_filter')
    const h = byId(hints, 'late-filter')
    expect(h.title).toBe('Condition on o is applied after the join')
    expect(h.detail).toContain('nullable side of the LEFT JOIN')
    const step = flow.find(s => s.node.type === 'Hash Join')!
    expect(step.late).toBe(true)
    expect(step.rowsIn).toBe(350000)
    expect(step.rowsOut).toBe(32480)
  })
  it('materialised CTE filtered outside', async () => {
    const { hints } = await analyze('cte_fence')
    const h = byId(hints, 'cte-fence')
    expect(h.detail).toContain('declared MATERIALIZED')
    expect(h.fix).toBe('with recent as not materialized (...)')
  })
  it('fan-out then DISTINCT', async () => {
    const { hints } = await analyze('fanout_distinct')
    const h = byId(hints, 'fan-out')
    expect(h.title).toContain('DISTINCT')
    expect(h.fix).toContain('exists')
  })
  it('cross join', async () => {
    const { hints } = await analyze('cross_join')
    expect(byId(hints, 'cross-join').severity).toBe('low')
  })
  it('sort spilling to disk', async () => {
    const { hints } = await analyze('sort_spill')
    const h = byId(hints, 'sort-disk')
    expect(h.fix).toMatch(/set work_mem = '\d+MB'/)
    expect(h.fixNote).toContain('create index concurrently on shop.events (occurred_at)')
  })
  it('hash batches', async () => {
    const { hints } = await analyze('hash_batches')
    expect(byId(hints, 'hash-batches').title).toBe('Hash join spills: 4 batches')
  })
  it('NOT IN', async () => {
    const { hints } = await analyze('not_in')
    expect(byId(hints, 'not-in').nodeId).toBe(0)
    expect(ids(hints)).not.toContain('seq-scan-index')
  })
  it('correlated subplan and the repeated scan under it', async () => {
    const { hints } = await analyze('correlated')
    expect(byId(hints, 'subplan-per-row').severity).toBe('high')
    expect(byId(hints, 'repeated-scan').fix).toBe('create index concurrently on shop.order_items (product_id);')
  })
  it('expression, trigram and date-cast predicates', async () => {
    expect(byId((await analyze('expr_lower')).hints, 'expr-index').fix).toBe('create index concurrently on shop.customers ((lower(email)));')
    expect(byId((await analyze('expr_like')).hints, 'trgm').fix).toContain('using gin (email gin_trgm_ops)')
    const cast = byId((await analyze('expr_cast')).hints, 'expr-rewrite')
    expect(cast.fix).toContain("placed_at >= '<day>'")
  })
  it('too many joins for the collapse limit', async () => {
    const { hints } = await analyze('many_joins')
    const h = byId(hints, 'join-collapse')
    expect(h.title).toContain('10 tables')
    expect(h.fix).toContain('set join_collapse_limit = 12')
  })
  it('misestimate with correlated columns suggests extended statistics', async () => {
    const { hints } = await analyze('misestimate')
    const h = byId(hints, 'ext-stats')
    expect(h.fix).toContain('create statistics orders_status_shipped_at_stats (dependencies, ndistinct, mcv) on status, shipped_at from shop.orders;')
  })
  it('offset pagination', async () => {
    expect(byId((await analyze('offset_page')).hints, 'offset').severity).toBe('high')
  })
  it('WHERE on the nullable side', async () => {
    expect(byId((await analyze('outer_where')).hints, 'outer-where').title).toBe('WHERE on o turns the outer join into an inner join')
  })
  it('OR across tables', async () => {
    const { hints } = await analyze('or_across')
    expect(byId(hints, 'or-across-tables').fix).toContain('union all')
  })
  it('is quiet on a plan with nothing wrong', async () => {
    const plan = parsePlan(JSON.stringify([{ Plan: { 'Node Type': 'Index Scan', 'Relation Name': 'orders', 'Alias': 'orders', 'Index Name': 'orders_pkey', 'Index Cond': '(id = 1)', 'Plan Rows': 1, 'Actual Rows': 1, 'Actual Loops': 1, 'Total Cost': 8.3, 'Startup Cost': 0.4, 'Actual Total Time': 0.02, 'Plan Width': 50 }, 'Execution Time': 0.05, 'Planning Time': 0.1 }]))
    expect(analyzePlan(plan).hints).toEqual([])
  })
})

describe('fixture sweep', () => {
  it('every fixture analyses without throwing', async () => {
    for (const f of readdirSync(dir).filter((f: string) => f.endsWith('.json'))) {
      const r = await analyze(f.replace(/\.json$/, ''))
      expect(r.flow.length).toBeGreaterThan(0)
    }
  })
})

// The real PostgreSQL parser, compiled to WebAssembly (libpg-query). Loaded
// on first use so it costs nothing until a plan is analysed. The package's
// own entry point locates the .wasm next to its script, which does not
// survive bundling, so this drives the emscripten factory directly.
import type { ParseResult } from '@pgsql/types'
import createModule from 'libpg-query/wasm/libpg-query.js'

export type { ParseResult }

interface Runtime {
  _malloc(n: number): number
  _free(p: number): void
  _wasm_parse_query_raw(p: number): number
  _wasm_free_parse_result(p: number): void
  getValue(p: number, t: 'i32'): number
  lengthBytesUTF8(s: string): number
  stringToUTF8(s: string, p: number, n: number): void
  UTF8ToString(p: number): string
}

export class SqlSyntaxError extends Error {
  constructor(message: string, public position: number) {
    super(message)
    this.name = 'SqlSyntaxError'
  }
}

let runtime: Promise<Runtime> | null = null

/** Starts loading the parser. `wasmBinary` bypasses the URL fetch (tests). */
export function initParser(opts: { wasmBinary?: ArrayBuffer } = {}): Promise<Runtime> {
  if (!runtime) {
    runtime = opts.wasmBinary
      ? createModule({ wasmBinary: opts.wasmBinary })
      : import('libpg-query/wasm/libpg-query.wasm?url').then(m => createModule({ locateFile: () => m.default }))
  }
  return runtime
}

/** Parses one or more statements into the Postgres raw parse tree. */
export async function parseSql(sql: string): Promise<ParseResult> {
  const m = await initParser()
  const len = m.lengthBytesUTF8(sql) + 1
  const input = m._malloc(len)
  m.stringToUTF8(sql, input, len)
  let result = 0
  try {
    result = m._wasm_parse_query_raw(input)
    if (!result) throw new Error('parser out of memory')
    const tree = m.getValue(result, 'i32')
    const err = m.getValue(result + 8, 'i32')
    if (err) {
      const message = m.UTF8ToString(m.getValue(err, 'i32'))
      const cursor = m.getValue(err + 16, 'i32')
      throw new SqlSyntaxError(message, Math.max(0, cursor - 1))
    }
    if (!tree) throw new Error('parser returned no tree')
    return JSON.parse(m.UTF8ToString(tree))
  } finally {
    m._free(input)
    if (result) m._wasm_free_parse_result(result)
  }
}

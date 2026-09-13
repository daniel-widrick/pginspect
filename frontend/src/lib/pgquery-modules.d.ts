declare module 'libpg-query/wasm/libpg-query.js' {
  const createModule: (opts?: Record<string, unknown>) => Promise<any>
  export default createModule
}

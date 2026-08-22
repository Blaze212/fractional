import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

export function loadGs(
  relPaths: string | string[],
  extraGlobals: Record<string, unknown> = {},
): Record<string, any> {
  const files = Array.isArray(relPaths) ? relPaths : [relPaths]
  const sandbox: Record<string, unknown> = { console, ...extraGlobals }
  vm.createContext(sandbox)

  for (const relPath of files) {
    const filePath = path.resolve(process.cwd(), relPath)
    vm.runInContext(readFileSync(filePath, 'utf-8'), sandbox, { filename: filePath })
  }

  return sandbox
}

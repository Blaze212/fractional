import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

export function loadGs(
  relPath: string,
  extraGlobals: Record<string, unknown> = {},
): Record<string, any> {
  const filePath = path.resolve(process.cwd(), relPath)
  const code = readFileSync(filePath, 'utf-8')
  const sandbox: Record<string, unknown> = { console, ...extraGlobals }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: filePath })
  return sandbox
}

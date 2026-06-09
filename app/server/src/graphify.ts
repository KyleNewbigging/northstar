import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readGraphifyGraph(projectPath: string) {
  const root = projectPath.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')
  const file = join(root, 'graphify-out', 'graph.json')
  if (!existsSync(file)) return null
  return { source: file, graph: JSON.parse(readFileSync(file, 'utf8')) }
}

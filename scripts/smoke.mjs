import { spawn } from 'node:child_process'

const baseUrl = process.env.NORTHSTAR_API_URL ?? 'http://127.0.0.1:4317'

let server = null

async function main() {
  const alreadyRunning = await canReachServer()
  if (!alreadyRunning) {
    server = spawn('npm', ['run', 'server'], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForServer()
  }

  const health = await getJson('/api/health')
  const projects = await getJson('/api/projects')
  const github = await getJson('/api/github/repositories')
  const allGraph = await getJson('/api/graph/all')
  const focusId = projects.projects?.find((project) => project.id === 'northstar')?.id ?? projects.projects?.[0]?.id
  const focusedGraph = await getJson(`/api/graph/${focusId}`)

  assert(health.ok === true, 'health endpoint failed')
  assert(Array.isArray(projects.projects) && projects.projects.length > 0, 'no projects discovered')
  assert(projects.projects.some((project) => project.localExists !== false), 'no local projects discovered')
  assert(projects.projects.some((project) => project.github), 'no GitHub-linked projects discovered')
  assert(Array.isArray(github.repositories), 'GitHub catalog endpoint failed')
  assert(Array.isArray(allGraph.nodes) && allGraph.nodes.length > 0, 'all-project graph has no nodes')
  assert(Array.isArray(focusedGraph.nodes) && focusedGraph.nodes.length > 0, 'focused graph has no nodes')

  const summary = {
    projects: projects.projects.length,
    local: projects.projects.filter((project) => project.localExists !== false).length,
    githubLinked: projects.projects.filter((project) => project.github).length,
    githubCatalog: github.repositories.length,
    graph: { nodes: allGraph.nodes.length, edges: allGraph.edges.length },
    focusedGraph: { project: focusId, nodes: focusedGraph.nodes.length, edges: focusedGraph.edges.length },
  }
  console.log(JSON.stringify(summary, null, 2))
}

async function canReachServer() {
  try {
    await getJson('/api/health')
    return true
  } catch {
    return false
  }
}

async function waitForServer() {
  const started = Date.now()
  while (Date.now() - started < 12000) {
    if (await canReachServer()) return
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  throw new Error('Northstar API did not start within 12 seconds.')
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    server?.kill('SIGTERM')
  })

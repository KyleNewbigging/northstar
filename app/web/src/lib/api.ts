const configuredApiUrl = (import.meta as ImportMeta & { env?: { VITE_NORTHSTAR_API_URL?: string } }).env?.VITE_NORTHSTAR_API_URL?.replace(/\/$/, '')

export function apiUrls(path: string) {
  return configuredApiUrl ? [path, `${configuredApiUrl}${path}`] : [path]
}

export function realtimeUrl(path: string) {
  if (configuredApiUrl) return `${configuredApiUrl.replace(/^http/, 'ws')}${path}`
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}`
}

export async function apiJson<T>(path: string): Promise<T | null> {
  for (const url of apiUrls(path)) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      return (await res.json()) as T
    } catch {
      // Try the next local API shape before falling back to seeded UI data.
    }
  }
  return null
}

export async function apiSend<T>(path: string, init: RequestInit): Promise<T | null> {
  for (const url of apiUrls(path)) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) continue
      return (await res.json()) as T
    } catch {
      // Try the next local API shape before falling back to optimistic UI state.
    }
  }
  return null
}

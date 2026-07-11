import { statusDot } from '../lib/format'
import type { Status } from '../types'

export function StatusTag({ status }: { status: Status }) {
  return (
    <span className="tag">
      <i className={`dot ${statusDot[status]}${status === 'running' ? ' live' : ''}`} />
      {status.replace('-', ' ').toUpperCase()}
    </span>
  )
}

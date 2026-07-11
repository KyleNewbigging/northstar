import { models } from '../data/seed'
import { modelColor } from '../lib/format'
import type { ModelId } from '../types'

export function ModelChip({ id, small = false }: { id: ModelId; small?: boolean }) {
  const model = models.find((item) => item.id === id)
  return (
    <span className="tag mono">
      <i className="dot" style={{ background: modelColor[id] }} />
      {small ? id.toUpperCase() : model?.label ?? id}
    </span>
  )
}

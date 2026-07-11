export type TaskLane = 'dev' | 'personal' | 'telegram-intent'

export function inferTaskLane(input: { projectId: string; source?: string }): TaskLane {
  if ((input.source ?? '').toLowerCase() === 'telegram') return 'telegram-intent'
  if (input.projectId === 'northstar') return 'dev'
  return 'personal'
}

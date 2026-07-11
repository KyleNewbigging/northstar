import { DatabaseSync } from 'node:sqlite'

const inboxExpiryMs = Math.max(60 * 60 * 1000, Number(process.env.NORTHSTAR_INBOX_EXPIRY_MS ?? 14 * 24 * 60 * 60 * 1000))
const telegramTaskExpiryMs = Math.max(60 * 60 * 1000, Number(process.env.NORTHSTAR_TELEGRAM_TASK_EXPIRY_MS ?? 10 * 24 * 60 * 60 * 1000))
const blockedRunExpiryMs = Math.max(60 * 60 * 1000, Number(process.env.NORTHSTAR_BLOCKED_RUN_EXPIRY_MS ?? 14 * 24 * 60 * 60 * 1000))

export function expireStaleItems(db: DatabaseSync): { inbox: number; tasks: number; runs: number } {
  const inboxOffset = `-${Math.round(inboxExpiryMs / 1000)} seconds`
  const telegramTaskOffset = `-${Math.round(telegramTaskExpiryMs / 1000)} seconds`
  const blockedRunOffset = `-${Math.round(blockedRunExpiryMs / 1000)} seconds`

  const inboxResult = db.prepare(
    `UPDATE inbox_actions
     SET resolved_at = CURRENT_TIMESTAMP, resolution = 'expired'
     WHERE resolved_at IS NULL
       AND created_at < datetime('now', ?)`,
  ).run(inboxOffset)

  const telegramResult = db.prepare(
    `UPDATE tasks
     SET status = 'done', stage = 'expired: stale telegram intent',
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('queued', 'needs-input')
       AND lane = 'telegram-intent'
       AND COALESCE(updated_at, created_at) < datetime('now', ?)`,
  ).run(telegramTaskOffset)

  const needsInputResult = db.prepare(
    `UPDATE tasks
     SET status = 'done', stage = 'expired: unanswered',
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'needs-input'
       AND lane != 'telegram-intent'
       AND COALESCE(updated_at, created_at) < datetime('now', ?)`,
  ).run(inboxOffset)

  const runsResult = db.prepare(
    `UPDATE agent_runs
     SET status = 'done', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'blocked'
       AND COALESCE(updated_at, started_at) < datetime('now', ?)`,
  ).run(blockedRunOffset)

  return {
    inbox: Number(inboxResult.changes),
    tasks: Number(telegramResult.changes) + Number(needsInputResult.changes),
    runs: Number(runsResult.changes),
  }
}

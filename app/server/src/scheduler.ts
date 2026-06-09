import type { DatabaseSync } from 'node:sqlite'

export type SchedulerSettings = {
  id: 'default'
  enabled: boolean
  timezone: string
  startTime: string
  endTime: string
  weekdayReservePct: number
  maxParallelRuns: number
  sparkEnabled: boolean
  opusEnabled: boolean
  codexEnabled: boolean
  updatedAt: string
}

type SchedulerRow = {
  id: 'default'
  enabled: number
  timezone: string
  start_time: string
  end_time: string
  weekday_reserve_pct: number
  max_parallel_runs: number
  spark_enabled: number
  opus_enabled: number
  codex_enabled: number
  updated_at: string
}

export function getSchedulerSettings(db: DatabaseSync): SchedulerSettings {
  seedSchedulerSettings(db)
  const row = db.prepare("SELECT * FROM scheduler_settings WHERE id = 'default'").get() as SchedulerRow
  return mapSchedulerRow(row)
}

export function updateSchedulerSettings(db: DatabaseSync, input: Partial<SchedulerSettings>) {
  const current = getSchedulerSettings(db)
  const next = {
    ...current,
    ...input,
    timezone: cleanTimezone(input.timezone ?? current.timezone),
    startTime: cleanTime(input.startTime ?? current.startTime, current.startTime),
    endTime: cleanTime(input.endTime ?? current.endTime, current.endTime),
    weekdayReservePct: clampNumber(input.weekdayReservePct ?? current.weekdayReservePct, 0, 90),
    maxParallelRuns: clampNumber(input.maxParallelRuns ?? current.maxParallelRuns, 1, 6),
  }

  db.prepare(
    `INSERT INTO scheduler_settings
      (id, enabled, timezone, start_time, end_time, weekday_reserve_pct, max_parallel_runs, spark_enabled, opus_enabled, codex_enabled, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       timezone = excluded.timezone,
       start_time = excluded.start_time,
       end_time = excluded.end_time,
       weekday_reserve_pct = excluded.weekday_reserve_pct,
       max_parallel_runs = excluded.max_parallel_runs,
       spark_enabled = excluded.spark_enabled,
       opus_enabled = excluded.opus_enabled,
       codex_enabled = excluded.codex_enabled,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    next.enabled ? 1 : 0,
    next.timezone,
    next.startTime,
    next.endTime,
    next.weekdayReservePct,
    next.maxParallelRuns,
    next.sparkEnabled ? 1 : 0,
    next.opusEnabled ? 1 : 0,
    next.codexEnabled ? 1 : 0,
  )

  return getSchedulerSettings(db)
}

export function seedSchedulerSettings(db: DatabaseSync) {
  db.prepare(
    `INSERT OR IGNORE INTO scheduler_settings
      (id, enabled, timezone, start_time, end_time, weekday_reserve_pct, max_parallel_runs, spark_enabled, opus_enabled, codex_enabled)
     VALUES ('default', 1, 'America/Toronto', '22:30', '06:30', 35, 2, 1, 1, 0)`,
  ).run()
}

function mapSchedulerRow(row: SchedulerRow): SchedulerSettings {
  return {
    id: row.id,
    enabled: row.enabled === 1,
    timezone: row.timezone,
    startTime: row.start_time,
    endTime: row.end_time,
    weekdayReservePct: row.weekday_reserve_pct,
    maxParallelRuns: row.max_parallel_runs,
    sparkEnabled: row.spark_enabled === 1,
    opusEnabled: row.opus_enabled === 1,
    codexEnabled: row.codex_enabled === 1,
    updatedAt: row.updated_at,
  }
}

function cleanTimezone(value: string) {
  return value.trim().replace(/[^A-Za-z0-9_/\-+:.]/g, '').slice(0, 64) || 'America/Toronto'
}

function cleanTime(value: string, fallback: string) {
  return /^\d{2}:\d{2}$/.test(value) ? value : fallback
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || min)))
}

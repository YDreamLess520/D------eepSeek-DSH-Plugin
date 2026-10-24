/**
 * 扫描所有会话日志，报告每个会话最新 system/message 的长度与本插件标记。
 * 用法：node tools/scan-sessions.mjs [since-minutes]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MARKER = 'oracle_council'
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const sinceMinutes = Number(process.argv[2] ?? 180)
const since = Date.now() - sinceMinutes * 60 * 1000
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeZstdFrames(buffer) {
  const offsets = []
  let cursor = buffer.indexOf(FRAME_MAGIC, 0)
  while (cursor !== -1) {
    offsets.push(cursor)
    cursor = buffer.indexOf(FRAME_MAGIC, cursor + 4)
  }
  if (offsets.length === 0 || offsets[0] !== 0) throw new Error('not a zstd frame log')
  const outputs = []
  let start = 0
  for (let index = 1; index <= offsets.length; index += 1) {
    const end = index < offsets.length ? offsets[index] : buffer.length
    if (end <= start) continue
    try {
      outputs.push(zstdDecompressSync(buffer.subarray(start, end)))
      start = end
    } catch {
      /* false-positive magic or unfinished tail */
    }
  }
  return Buffer.concat(outputs).toString('utf8')
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const rows = []
for (const cwdKey of readdirSync(SESSIONS_ROOT)) {
  const cwdDir = join(SESSIONS_ROOT, cwdKey)
  let entries
  try {
    entries = readdirSync(cwdDir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(cwdDir, entry.name, 'session.v4.jsonl.zstd')
    let stats
    try {
      stats = statSync(file)
    } catch {
      continue
    }
    if (stats.mtimeMs < since) continue
    let events
    try {
      events = decodeZstdFrameText(file)
    } catch {
      continue
    }
    const systems = events.filter((event) => event.type === 'system/message')
    const latest = systems.at(-1)
    const text = latest ? textOf(latest.data.message) : ''
    rows.push({
      session: entry.name,
      mtime: stats.mtime,
      events: events.length,
      systems: systems.length,
      chars: text.length,
      marker: text.includes(MARKER),
      turn: latest?.data?.turn,
    })
  }
}

function decodeZstdFrameText(file) {
  const text = decodeZstdFrames(readFileSync(file))
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

rows.sort((a, b) => b.mtime - a.mtime)
for (const row of rows) {
  console.log(
    `${row.mtime.toISOString()}  ${row.session}  events=${row.events} systems=${row.systems} chars=${row.chars} marker=${row.marker} turn=${row.turn}`,
  )
}
console.log(`\nscanned ${rows.length} sessions modified in the last ${sinceMinutes} minutes`)

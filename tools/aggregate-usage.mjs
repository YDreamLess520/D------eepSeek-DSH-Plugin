/**
 * 汇总指定会话（父/子）的 token 用量与墙钟，用于验证"一条消息烧了多少"。
 *
 * 用法：
 *   node tools/aggregate-usage.mjs <session-id-prefix> [more prefixes...] [--since ISO时间]
 *
 * 输出每个会话的：事件数、turn 数、assistant 消息数、工具调用数、
 * input/output/cacheRead/total tokens、首末事件时间与墙钟；最后给合计。
 * 只读会话日志，不修改任何东西。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
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
      /* 伪 magic 或末尾半帧 */
    }
  }
  return Buffer.concat(outputs).toString('utf8')
}

function findSessionLog(prefix) {
  for (const cwdKey of readdirSync(SESSIONS_ROOT)) {
    const dir = join(SESSIONS_ROOT, cwdKey)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
      const file = join(dir, entry.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) return file
    }
  }
  return undefined
}

const args = process.argv.slice(2)
let since
const prefixes = []
for (const arg of args) {
  if (arg.startsWith('--since=')) since = Date.parse(arg.slice('--since='.length))
  else prefixes.push(arg)
}

function summarize(prefix) {
  const file = findSessionLog(prefix)
  if (!file) return { prefix, missing: true }
  const text = decodeZstdFrames(readFileSync(file))
  const events = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
  const filtered = since ? events.filter((event) => (event.time ?? 0) >= since) : events
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
  let assistantMessages = 0
  let turns = new Set()
  let toolCalls = 0
  let firstTime
  let lastTime
  for (const event of filtered) {
    if (event.time !== undefined) {
      if (firstTime === undefined || event.time < firstTime) firstTime = event.time
      if (lastTime === undefined || event.time > lastTime) lastTime = event.time
    }
    if (event.type === 'turn/start') turns.add(event.data?.turn)
    if (event.type === 'tool/call') toolCalls += 1
    if (event.type === 'assistant/message') {
      assistantMessages += 1
      const u = event.data?.usage
      if (u) for (const key of Object.keys(usage)) usage[key] += u[key] ?? 0
    }
  }
  return {
    prefix,
    events: filtered.length,
    turns: turns.size,
    assistantMessages,
    toolCalls,
    usage,
    wallMs: firstTime !== undefined && lastTime !== undefined ? lastTime - firstTime : undefined,
  }
}

const rows = prefixes.map(summarize)
const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
for (const row of rows) {
  if (row.missing) {
    console.log(`${row.prefix}: MISSING`)
    continue
  }
  for (const key of Object.keys(totals)) totals[key] += row.usage[key]
  const wall = row.wallMs === undefined ? '-' : `${(row.wallMs / 1000).toFixed(1)}s`
  console.log(
    `${row.prefix}: events=${row.events} turns=${row.turns} assistant=${row.assistantMessages} toolCalls=${row.toolCalls} ` +
      `in=${row.usage.inputTokens} out=${row.usage.outputTokens} cacheRead=${row.usage.cacheReadTokens} total=${row.usage.totalTokens} wall=${wall}`,
  )
}
console.log(
  `TOTAL: in=${totals.inputTokens} out=${totals.outputTokens} cacheRead=${totals.cacheReadTokens} total=${totals.totalTokens}`,
)

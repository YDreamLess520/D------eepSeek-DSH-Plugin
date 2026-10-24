/**
 * 验证工具：检查一条会话日志里的系统提示是否包含本插件的深度推演段。
 *
 * 用法：
 *   node tools/session-prompt-check.mjs <session-id 或 session-id 前缀>
 *   node tools/session-prompt-check.mjs <session-id> --events
 *
 * 说明：会话日志是 `$DSH_HOME/sessions/<编码后的 cwd>/<session-id>/session.v4.jsonl.zstd`；
 * `$DSH_HOME` 默认 `~/.dsh`，也可用环境变量覆盖。只读，不修改会话。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MARKER = 'oracle_council'
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

function findSessionLog(prefix) {
  if (!existsSync(SESSIONS_ROOT)) return undefined
  for (const directory of readdirSync(SESSIONS_ROOT)) {
    const dir = join(SESSIONS_ROOT, directory)
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(prefix)) continue
      const file = join(dir, entry.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) return file
      const plain = join(dir, entry.name, 'session.v4.jsonl')
      if (existsSync(plain)) return plain
    }
  }
  return undefined
}

/**
 * 会话日志是「多个 zstd frame 直接首尾相接」的追加式文件，而 Node 的流式 zstd 解压
 * 不跨 frame。这里按标准 frame magic 切段逐帧解压；压缩载荷里偶尔出现的伪 magic 由
 * 「解码失败就把下一段并进来重试」兜底，末尾正在写入的半帧直接忽略。
 */
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
      // 伪 magic 或末尾未写完的半帧：继续并下一段再试
    }
  }
  return Buffer.concat(outputs).toString('utf8')
}

async function decode(file) {
  const bytes = readFileSync(file)
  const text = file.endsWith('.zstd') ? decodeZstdFrames(bytes) : bytes.toString('utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const prefix = process.argv[2]
const showEvents = process.argv.includes('--events')
if (!prefix) {
  console.error('usage: node tools/session-prompt-check.mjs <session-id-prefix> [--events]')
  process.exit(2)
}

const file = findSessionLog(prefix)
if (!file) {
  console.error(`no session log found for prefix "${prefix}" under ${SESSIONS_ROOT}`)
  process.exit(2)
}

const events = await decode(file)
console.log(`log: ${file}`)
console.log(`events: ${events.length}, last seq: ${events.at(-1)?.seq}`)

const systemMessages = events.filter((event) => event.type === 'system/message')
console.log(`system/message events: ${systemMessages.length}`)
for (const event of systemMessages) {
  const text = textOf(event.data.message)
  console.log(
    `  seq=${event.seq} turn=${event.data.turn} step=${event.data.step} chars=${text.length} marker=${text.includes(MARKER)}`,
  )
}

if (showEvents) {
  console.log('\nlast 25 events:')
  for (const event of events.slice(-25)) {
    const extra = event.type === 'assistant/message' ? ` usage=${JSON.stringify(event.data.usage ?? null)}` : ''
    console.log(`  ${event.seq} ${event.type}${extra}`)
  }
}

const latest = systemMessages.at(-1)
const latestText = latest ? textOf(latest.data.message) : ''
console.log(`\nlatest system prompt: ${latestText.length} chars, marker present: ${latestText.includes(MARKER)}`)
if (!latestText.includes(MARKER)) {
  console.log('RESULT: plugin prompt section NOT present in the latest system prompt')
  process.exitCode = 1
} else {
  const index = latestText.indexOf(`<${MARKER}>`)
  console.log('RESULT: plugin prompt section PRESENT in the latest system prompt')
  console.log('--- excerpt ---')
  console.log(latestText.slice(index, index + 420))
}

/**
 * 离线断言：用假的 Cordis ctx 验证合并插件（第一轮议会 / 闸门 / 兜底 / 可选深化）。
 * 运行：node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import {
  apply,
  readConfig,
  countDispatched,
  isTrivial,
  chooseTier,
  TIER_COUNTS,
  oracleText,
  fallbackText,
  leafText,
  gateText,
} from '../index.js'

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

const SIGNAL = new AbortController().signal

function userMessage(text, sourceKind = 'user') {
  return { role: 'user', id: `m-${Math.random().toString(16).slice(2)}`, content: [{ type: 'text', text }], source: { kind: sourceKind } }
}

function makeAgent(id = 'agent-1') {
  const calls = []
  return {
    id,
    inbox: { nextTurn: [], nextStep: [] },
    followup: async (message) => {
      calls.push(message)
    },
    calls,
  }
}

function makeHarness(options = {}) {
  const agent = options.agent ?? makeAgent()
  const available = new Set(options.available ?? ['systemPrompt', 'agents', 'tools'])
  const toolPresent = options.toolPresent !== false
  const sections = []
  const listeners = new Map()
  const ctx = {
    agents: available.has('agents') ? { roots: () => (options.roots ?? [agent]) } : undefined,
    tools: available.has('tools') ? { get: () => (toolPresent ? { name: 'workflow' } : undefined) } : undefined,
    systemPrompt: available.has('systemPrompt')
      ? {
          section: (section) => {
            sections.push(section)
            return () => {}
          },
        }
      : undefined,
    inject(dependencies, callback) {
      if (dependencies.every((name) => available.has(name))) callback(this)
      return () => {}
    },
    get(name) {
      return available.has(name) ? this[name] : undefined
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
  }
  apply(ctx, options.config ?? {})
  const handlers = (name) => listeners.get(name) ?? []
  return { ctx, sections, listeners, handlers, agent, calls: agent.calls }
}

async function preStep(harness, { step = 1, turn = 1, messages = [userMessage('帮我分析一下这个方案')] } = {}) {
  const listener = harness.handlers('agent/pre-step')[0]
  assert.ok(listener, 'pre-step listener registered')
  return listener({ agent: harness.agent, turn, step, messages, signal: SIGNAL }, async () => ({ kind: 'enter', messages }))
}

async function turnStopping(harness, turn = 1) {
  for (const listener of harness.handlers('agent/turn-stopping')) {
    await listener({ agent: harness.agent, turn, signal: SIGNAL })
  }
}

function workflowResult(harness, count) {
  const listener = harness.handlers('tools/result')[0]
  assert.ok(listener, 'tools/result listener registered')
  listener({ name: 'workflow', agent: harness.agent }, {
    isError: false,
    content: [{ type: 'text', text: `workflow "council" completed (${count} agents).\nReturn value: ...` }],
  })
}

function workflowError(harness) {
  harness.handlers('tools/result')[0](
    { name: 'workflow', agent: harness.agent },
    { isError: true, content: [{ type: 'text', text: 'Error: workflow run failed: boom' }] },
  )
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test('readConfig: 默认值', () => {
  const config = readConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.dimensions, 10)
  assert.equal(config.gateRetries, 1)
  assert.equal(config.extraPasses, 0)
  assert.equal(config.reasoningEffort, 'max')
  assert.deepEqual([...config.effortProviders], ['deepseek-account'])
  assert.equal(config.workflowToolName, 'workflow')
  assert.equal(config.trivialBypass, false)
  assert.equal(config.autoTier, false)
  assert.equal(config.maxCallsPerTurn, 2)
  assert.equal(config.sectionOrder, 10300)
})

test('readConfig: 边界收敛', () => {
  assert.equal(readConfig({ dimensions: 99 }).dimensions, 15)
  assert.equal(readConfig({ dimensions: 1 }).dimensions, 7)
  assert.equal(readConfig({ dimensions: 7 }).dimensions, 7)
  assert.equal(readConfig({ dimensions: 15 }).dimensions, 15)
  assert.equal(readConfig({ gateRetries: 9 }).gateRetries, 2)
  assert.equal(readConfig({ gateRetries: -1 }).gateRetries, 0)
  assert.equal(readConfig({ extraPasses: 9 }).extraPasses, 3)
  assert.equal(readConfig({ extraPasses: -3 }).extraPasses, 0)
  assert.equal(readConfig({ reasoningEffort: 'HIGH' }).reasoningEffort, 'high')
  assert.equal(readConfig({ reasoningEffort: 'bogus' }).reasoningEffort, 'max')
  assert.equal(readConfig({ reasoningEffort: false }).reasoningEffort, null)
  assert.equal(readConfig({ effortProviders: false }).effortProviders.length, 0)
  assert.equal(readConfig({ trivialBypass: true }).trivialBypass, true)
  assert.equal(readConfig({ autoTier: true }).autoTier, true)
  assert.equal(readConfig({ maxCallsPerTurn: 9 }).maxCallsPerTurn, 3)
  assert.equal(readConfig({ maxCallsPerTurn: 0 }).maxCallsPerTurn, 1)
  assert.equal(readConfig({ workflowToolName: 'council' }).workflowToolName, 'council')
  assert.equal(readConfig({ enabled: false }).enabled, false)
})

test('apply: 注册系统提示段', () => {
  const h = makeHarness()
  assert.equal(h.sections.length, 1)
  const section = h.sections[0]
  assert.equal(section.name, 'd-eepseek:oracle')
  assert.equal(section.order, 10300)
  assert.equal(section.interpolate, false)
})

test('apply: enabled=false 什么都不注册', () => {
  const h = makeHarness({ config: { enabled: false } })
  assert.equal(h.sections.length, 0)
  assert.equal(h.listeners.size, 0)
})

test('protocol: 根会话要求第一动作与默认 10 个维度', () => {
  const h = makeHarness()
  const text = h.sections[0].text({ agent: h.agent })
  assert.match(text, /must be ONE `workflow` tool call/)
  assert.match(text, /default 10/)
  assert.match(text, /oracle_tier/)
  assert.match(text, /leaf analyst/)
  assert.match(text, /single visible answer/)
  assert.match(text, /superseded/)
  assert.match(text, /run_in_background/)
  assert.match(text, /converge to the single most likely conclusion|decide which ONE interpretation/)
  assert.match(text, /Follow-up calls in the same turn/)
  assert.match(text, /At most 2 workflow calls per turn/)
})

test('protocol: 子 agent 只拿叶子协议', () => {
  const root = makeAgent('root')
  const child = makeAgent('child')
  const h = makeHarness({ agent: root, roots: [root] })
  const text = h.sections[0].text({ agent: child })
  assert.equal(text, leafText())
  assert.match(text, /leaf analyst/)
  assert.match(text, /Do not call workflow, subagent, or delegate further/)
  assert.doesNotMatch(text, /oracle_council/)
})

test('protocol: 没有 workflow 工具时退回单轮深度', () => {
  const h = makeHarness({ toolPresent: false })
  const text = h.sections[0].text({ agent: h.agent })
  assert.equal(text, fallbackText(10))
  assert.match(text, /single-agent/)
})

test('protocol: dimensions=7 时文案随之变化', () => {
  const h = makeHarness({ config: { dimensions: 7 } })
  const text = h.sections[0].text({ agent: h.agent })
  assert.match(text, /default 7/)
  assert.match(text, /7 genuinely different angles/)
})

test('protocol: 支持到 dimensions=15', () => {
  const h = makeHarness({ config: { dimensions: 15 } })
  const text = h.sections[0].text({ agent: h.agent })
  assert.match(text, /default 15/)
  assert.match(text, /Choose 15 genuinely different angles/)
})

test('protocol: assemble 没带 agent 时返回空串', () => {
  const h = makeHarness()
  assert.equal(h.sections[0].text({}), '')
})

// ---------------------------------------------------------------------------
// reasoning effort
// ---------------------------------------------------------------------------

test('agent/request: deepseek-account 的 low 被抬到 max', async () => {
  const h = makeHarness()
  const waterfall = h.handlers('agent/request')[0]
  const result = await waterfall({}, async () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }))
  assert.equal(result.reasoningEffort, 'max')
})

test('agent/request: 其它 provider 原样放行', async () => {
  const h = makeHarness()
  const waterfall = h.handlers('agent/request')[0]
  const result = await waterfall({}, async () => ({ provider: 'pi-ai', model: 'x', reasoningEffort: 'low' }))
  assert.equal(result.reasoningEffort, 'low')
})

test('agent/request: reasoningEffort=false 时不注册', () => {
  const h = makeHarness({ config: { reasoningEffort: false } })
  assert.equal(h.handlers('agent/request').length, 0)
})

// ---------------------------------------------------------------------------
// 闸门
// ---------------------------------------------------------------------------

test('闸门: 派发满 10 路时不再补发', async () => {
  const h = makeHarness()
  await preStep(h)
  workflowResult(h, 10)
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('闸门: 派发不足时补发一次，且只补一次', async () => {
  const h = makeHarness()
  await preStep(h)
  workflowResult(h, 2)
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].content[0].text, /started 2 of the 10 required analysis branches/)
  assert.equal(h.calls[0].role, 'user')
  assert.equal(typeof h.calls[0].id, 'string')
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
})

test('闸门: 补发后补齐也不再补发', async () => {
  const h = makeHarness()
  await preStep(h)
  workflowResult(h, 2)
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
  workflowResult(h, 8)
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
})

test('闸门: gateRetries=0 时完全不补发', async () => {
  const h = makeHarness({ config: { gateRetries: 0 } })
  await preStep(h)
  workflowResult(h, 1)
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('闸门: 没有观察到本轮第一个 step（安装/热更时已在回合中）不追溯补发', async () => {
  const h = makeHarness()
  // 不调用 preStep：会话在插件加载前就已开始
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('闸门: 子 agent 不补发', async () => {
  const root = makeAgent('root')
  const child = makeAgent('child')
  const h = makeHarness({ agent: child, roots: [root] })
  await preStep(h)
  workflowResult(h, 0)
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('闸门: 新回合重置计数', async () => {
  const h = makeHarness()
  await preStep(h, { turn: 1 })
  workflowResult(h, 10)
  await turnStopping(h, 1)
  assert.equal(h.calls.length, 0)
  await preStep(h, { turn: 2 })
  await turnStopping(h, 2)
  assert.equal(h.calls.length, 1)
})

test('闸门: 用户已排队下一句时让位', async () => {
  const h = makeHarness()
  await preStep(h)
  h.agent.inbox.nextTurn = [userMessage('新的问题')]
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('闸门: 取消信号已触发时让位', async () => {
  const h = makeHarness()
  await preStep(h)
  const controller = new AbortController()
  controller.abort()
  for (const listener of h.handlers('agent/turn-stopping')) {
    await listener({ agent: h.agent, turn: 1, signal: controller.signal })
  }
  assert.equal(h.calls.length, 0)
})

test('闸门: workflow 失败不计入派发', async () => {
  const h = makeHarness()
  await preStep(h)
  workflowError(h)
  await turnStopping(h)
  assert.equal(h.calls.length, 1) // 失败后允许补一次
})

test('闸门: 当前 preset 没有 workflow 工具时不补发', async () => {
  const h = makeHarness({ toolPresent: false })
  await preStep(h)
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('闸门: 后台受理（run_in_background）视为已派发，不重复启动', async () => {
  const h = makeHarness()
  await preStep(h)
  h.handlers('tools/result')[0](
    { name: 'workflow', agent: h.agent },
    { isError: false, content: [{ type: 'text', text: 'workflow "council" started in the background as job job-1.' }] },
  )
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('countDispatched: 解析渲染文本，错误结果返回 undefined', () => {
  assert.equal(
    countDispatched({ content: [{ type: 'text', text: 'workflow "x" completed (5 agents).' }] }),
    5,
  )
  assert.equal(countDispatched({ content: [{ type: 'text', text: 'workflow "x" completed (1 agent).' }] }), 1)
  assert.equal(countDispatched({ content: [{ type: 'text', text: '没有数字' }] }), undefined)
  assert.equal(countDispatched({ isError: true, content: [{ type: 'text', text: 'completed (9 agents)' }] }), undefined)
})

// ---------------------------------------------------------------------------
// trivialBypass
// ---------------------------------------------------------------------------

test('isTrivial: 寒暄命中，任务型消息不命中', () => {
  assert.equal(isTrivial('你好'), true)
  assert.equal(isTrivial('OK'), true)
  assert.equal(isTrivial('帮我写个插件'), false)
  assert.equal(isTrivial('这个方案能行吗？'), false)
  assert.equal(isTrivial('please analyze this'), false)
  assert.equal(isTrivial(''), true)
})

test('trivialBypass: 开启时注入豁免提示并跳过闸门', async () => {
  const h = makeHarness({ config: { trivialBypass: true } })
  const decision = await preStep(h, { messages: [userMessage('你好')] })
  assert.match(decision.messages.at(-1).content[0].text, /oracle_bypass/)
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('trivialBypass: 任务型消息不豁免', async () => {
  const h = makeHarness({ config: { trivialBypass: true } })
  const decision = await preStep(h, { messages: [userMessage('帮我分析一下这个方案')] })
  assert.ok(decision.messages.every((message) => !JSON.stringify(message).includes('oracle_bypass')))
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
})

test('trivialBypass: 默认关闭时寒暄消息也触发闸门', async () => {
  const h = makeHarness()
  await preStep(h, { messages: [userMessage('你好')] })
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
})

// ---------------------------------------------------------------------------
// autoTier（按消息复杂度自动选 7 / 10 / 15）
// ---------------------------------------------------------------------------

test('chooseTier: 简单/普通/深问题分别落在 7/10/15', () => {
  assert.deepEqual(chooseTier('你好'), { label: 'quick', count: 7 })
  assert.equal(chooseTier('帮我看看这个文件').count, 7)
  assert.equal(
    chooseTier('我想知道这个功能目前的实现方式是什么，以及有没有更简单的写法可以替换它，最好能给个示例').count,
    10,
  )
  assert.deepEqual(chooseTier('我们要把现有系统迁移到新架构，回滚和安全风险怎么评估？'), { label: 'deep', count: 15 })
  assert.equal(chooseTier('x'.repeat(200)).label, 'deep')
  assert.deepEqual(TIER_COUNTS, { quick: 7, standard: 10, deep: 15 })
})

test('autoTier: 简单消息注入 7 路档位并按 7 判闸门', async () => {
  const h = makeHarness({ config: { autoTier: true } })
  const decision = await preStep(h, { messages: [userMessage('你好')] })
  assert.match(decision.messages.at(-1).content[0].text, /<oracle_tier count="7" label="quick">/)
  workflowResult(h, 7)
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('autoTier: 复杂问题升到 15 路，闸门按 15 判', async () => {
  const h = makeHarness({ config: { autoTier: true } })
  const decision = await preStep(h, { messages: [userMessage('我们要把现有系统迁移到新架构，回滚和安全风险怎么评估？')] })
  assert.match(decision.messages.at(-1).content[0].text, /<oracle_tier count="15" label="deep">/)
  workflowResult(h, 10)
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].content[0].text, /started 10 of the 15 required analysis branches/)
})

test('autoTier: 关闭时不注入档位通知', async () => {
  const h = makeHarness()
  const decision = await preStep(h, { messages: [userMessage('你好')] })
  assert.ok(decision.messages.every((message) => !JSON.stringify(message).includes('oracle_tier')))
})

test('autoTier: trivialBypass 优先，不注入档位', async () => {
  const h = makeHarness({ config: { autoTier: true, trivialBypass: true } })
  const decision = await preStep(h, { messages: [userMessage('你好')] })
  const last = JSON.stringify(decision.messages.at(-1))
  assert.match(last, /oracle_bypass/)
  assert.doesNotMatch(last, /oracle_tier/)
})

// ---------------------------------------------------------------------------
// 同回合多次调用（maxCallsPerTurn 硬上限）
// ---------------------------------------------------------------------------

test('pre-execute: 同回合允许两次 workflow 调用，第 3 次被硬拦', async () => {
  const h = makeHarness()
  await preStep(h)
  const guard = h.handlers('tools/pre-execute')[0]
  assert.ok(guard, 'pre-execute listener registered')
  const allow = async () => ({ kind: 'allow' })
  const first = await guard({ name: 'workflow', agent: h.agent }, allow)
  const second = await guard({ name: 'workflow', agent: h.agent }, allow)
  const third = await guard({ name: 'workflow', agent: h.agent }, allow)
  assert.equal(first.kind, 'allow')
  assert.equal(second.kind, 'allow')
  assert.equal(third.kind, 'deny')
  assert.match(third.reason, /call limit reached \(2 per turn\)/)
  assert.equal(third.info.code, 'ORACLE_CALL_LIMIT')
})

test('pre-execute: maxCallsPerTurn=1 时第二次即被拦', async () => {
  const h = makeHarness({ config: { maxCallsPerTurn: 1 } })
  await preStep(h)
  const guard = h.handlers('tools/pre-execute')[0]
  const allow = async () => ({ kind: 'allow' })
  assert.equal((await guard({ name: 'workflow', agent: h.agent }, allow)).kind, 'allow')
  assert.equal((await guard({ name: 'workflow', agent: h.agent }, allow)).kind, 'deny')
})

test('pre-execute: 非 workflow 工具与 trivialBypass 回合不受限', async () => {
  const h = makeHarness({ config: { trivialBypass: true } })
  await preStep(h, { messages: [userMessage('你好')] })
  const guard = h.handlers('tools/pre-execute')[0]
  const allow = async () => ({ kind: 'allow' })
  assert.equal((await guard({ name: 'read', agent: h.agent }, allow)).kind, 'allow')
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await guard({ name: 'workflow', agent: h.agent }, allow)).kind, 'allow')
  }
})

test('pre-execute: 调用上限按回合重置', async () => {
  const h = makeHarness({ config: { maxCallsPerTurn: 1 } })
  const guard = h.handlers('tools/pre-execute')[0]
  const allow = async () => ({ kind: 'allow' })
  await preStep(h, { turn: 1 })
  assert.equal((await guard({ name: 'workflow', agent: h.agent }, allow)).kind, 'allow')
  assert.equal((await guard({ name: 'workflow', agent: h.agent }, allow)).kind, 'deny')
  await preStep(h, { turn: 2 })
  assert.equal((await guard({ name: 'workflow', agent: h.agent }, allow)).kind, 'allow')
})

test('pre-execute: 前面其它 guard 拒绝时不计调用次数', async () => {
  const h = makeHarness({ config: { maxCallsPerTurn: 1 } })
  await preStep(h)
  const guard = h.handlers('tools/pre-execute')[0]
  const deny = async () => ({ kind: 'deny', reason: 'denied by other guard' })
  assert.equal((await guard({ name: 'workflow', agent: h.agent }, deny)).kind, 'deny')
  const allow = async () => ({ kind: 'allow' })
  assert.equal((await guard({ name: 'workflow', agent: h.agent }, allow)).kind, 'allow')
})

// ---------------------------------------------------------------------------
// 可选深化回合 / 清理
// ---------------------------------------------------------------------------

test('extraPasses=1: 综合完成后追加一次深化回合', async () => {
  const h = makeHarness({ config: { extraPasses: 1 } })
  await preStep(h)
  workflowResult(h, 10)
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].content[0].text, /oracle_deepening pass="1" of="1"/)
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
})

test('extraPasses=1: 用户新输入重置深化计数', async () => {
  const h = makeHarness({ config: { extraPasses: 1 } })
  const claimed = h.handlers('agent/inbox/claimed')[0]
  await preStep(h)
  workflowResult(h, 10)
  await turnStopping(h)
  assert.equal(h.calls.length, 1)
  claimed({ agent: h.agent, message: { source: { kind: 'user' } } })
  await turnStopping(h)
  assert.equal(h.calls.length, 2)
})

test('agent/disposed: 清理状态后不残留', async () => {
  const h = makeHarness()
  const disposed = h.handlers('agent/disposed')[0]
  await preStep(h)
  workflowResult(h, 2)
  disposed({ agent: h.agent })
  await turnStopping(h)
  assert.equal(h.calls.length, 0)
})

test('gateText: 缺失数量与一次重试提示', () => {
  const text = gateText(3, 10)
  assert.match(text, /started 3 of the 10 required analysis branches/)
  assert.match(text, /missing 7 dimensions/)
  assert.match(text, /do not retry more than once/)
})

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed > 0) process.exitCode = 1

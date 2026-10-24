/**
 * D-------eepSeek — 深度议会插件（Host-only bundle）
 *
 * 目标：一条用户消息 = 第一轮思考内完成「多维度并行深挖 + 综合回答」，
 * 让回答更深更广、思考 token 消耗显著放大，同时用硬上限保证不是死循环。
 *
 * 与本目录旧插件 `dsh-deep-deliberation` 的关系：本插件是它的合并升级版。
 * 旧插件的「回合结束后再补一轮深化」默认关闭（extraPasses: 0），
 * 重活改在**第一轮、回答之前**完成：
 *
 *  1. `ctx.systemPrompt.section()`：注入议会协议（根会话）或叶子分析员协议（子 agent）。
 *     根会话被明确要求：**第一个动作**必须是 `workflow` 工具里并行启动 N 个 `agent()`
 *     分支，结果返回前不得写最终回答。子 agent 只拿到叶子指令，禁止再派发（防递归）。
 *  2. `agent/request`（waterfall, prepend）：把请求 reasoning effort 抬到最强档
 *     （默认 max，仅对白名单 provider 生效）。
 *  3. `agent/pre-step` + `tools/result` + `agent/turn-stopping`：闸门。
 *     记录本轮 `workflow` 工具结果里的子 agent 数；回合即将结束时若 < N，
 *     只用一次 followup 要求补齐（gateRetries，默认 1），之后放行——不循环。
 *     只在「本轮第一个 step 被本插件看到」时生效，避免安装/热更后对已进行的回合追溯补课。
 *  4. `agent/turn-stopping`（可选，默认 0）：旧插件的「自我深化回合」，按需开启。
 *
 * 设计纪律：
 *  - 零依赖、无构建步骤（本地 bundle 解析不到 dsh 安装目录的依赖）。
 *  - fail-open：服务/工具缺失、子 agent、取消信号、用户已排队输入时一律让位。
 *  - 除闸门补发这一种兜底外，不在正常路径上追加任何回合。
 *  - 不写 session 自定义事件、不改工具、不改审批；状态只在内存。
 *
 * 可调参数（profile 的 cordis.patch.yml 里按 row id `d-eepseek` 覆盖）：
 *  - enabled            false = 整插件不注册（默认 true）
 *  - dimensions         议会并行维度数，7..15（默认 10；除总 agent 外的子 agent 个数）
 *  - gateRetries        派发不足时最多补发几次 followup，0..2（默认 1）
 *  - extraPasses        综合完成后追加的深化回合数，0..3（默认 0）
 *  - reasoningEffort    off|low|high|max|false（默认 max；false = 不改请求）
 *  - effortProviders    string[]，允许强制 effort 的 provider（默认 ['deepseek-account']）
 *  - workflowToolName   workflow 工具名（默认 'workflow'）
 *  - trivialBypass      true 时，极短寒暄类消息跳过议会要求（默认 false）
 *  - autoTier           true 时按消息复杂度自动选 7/10/15 路（默认 false；bundle patch 中本机已启用）
 *  - maxCallsPerTurn    同一回合最多允许几次 workflow 调用，1..3（默认 2；第 3 次会被硬拦）
 *  - sectionOrder       系统提示排序位（默认 10300）
 */

const SECTION_NAME = 'd-eepseek:oracle'
const SOURCE_KIND = 'd-eepseek'
const DEFAULT_SECTION_ORDER = 10300
const DEFAULT_EFFORT = 'max'
const EFFORT_IDS = new Set(['off', 'low', 'high', 'max'])
const DEFAULT_EFFORT_PROVIDERS = Object.freeze(['deepseek-account'])
const TRIVIAL_MAX_CHARS = 8

/** 各配置的合法区间。 */
const LIMITS = Object.freeze({
  dimensions: { fallback: 10, min: 7, max: 15 },
  gateRetries: { fallback: 1, min: 0, max: 2 },
  extraPasses: { fallback: 0, min: 0, max: 3 },
})

function clampInteger(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function normalizeEffort(value) {
  if (value === false || value === null) return null
  if (value === undefined) return DEFAULT_EFFORT
  const text = String(value).trim().toLowerCase()
  if (text === '' || text === 'keep' || text === 'none' || text === 'default') return null
  return EFFORT_IDS.has(text) ? text : DEFAULT_EFFORT
}

function normalizeProviders(value) {
  if (value === false) return Object.freeze([])
  if (value === undefined || value === null || value === true) return DEFAULT_EFFORT_PROVIDERS
  const list = Array.isArray(value) ? value : [value]
  const providers = list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return Object.freeze(providers)
}

/** 校验并补全配置；无法识别的字段退回默认值。 */
export function readConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return Object.freeze({
    enabled: config.enabled !== false,
    dimensions: clampInteger(config.dimensions, LIMITS.dimensions.fallback, LIMITS.dimensions.min, LIMITS.dimensions.max),
    gateRetries: clampInteger(config.gateRetries, LIMITS.gateRetries.fallback, LIMITS.gateRetries.min, LIMITS.gateRetries.max),
    extraPasses: clampInteger(config.extraPasses, LIMITS.extraPasses.fallback, LIMITS.extraPasses.min, LIMITS.extraPasses.max),
    reasoningEffort: normalizeEffort(config.reasoningEffort),
    effortProviders: normalizeProviders(config.effortProviders ?? config.providers),
    workflowToolName:
      typeof config.workflowToolName === 'string' && config.workflowToolName.trim().length > 0
        ? config.workflowToolName.trim()
        : 'workflow',
    trivialBypass: config.trivialBypass === true,
    autoTier: config.autoTier === true,
    maxCallsPerTurn: clampInteger(config.maxCallsPerTurn, 2, 1, 3),
    sectionOrder: Number.isFinite(config.sectionOrder) ? config.sectionOrder : DEFAULT_SECTION_ORDER,
  })
}

/** 宽松 UUID：优先 crypto.randomUUID，环境没有时退化为随机 hex。 */
function newMessageId() {
  const crypto = globalThis.crypto
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  let text = ''
  for (let index = 0; index < 32; index += 1) text += Math.floor(Math.random() * 16).toString(16)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

/** 构造一条完整用户消息（followup 需要 role/id/content/source，缺 role 会 422）。 */
function userMessage(text, summary) {
  return {
    role: 'user',
    id: newMessageId(),
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  }
}

/** 失败只告警，不打断回合、不让插件加载失败。 */
function warn(ctx, message) {
  try {
    if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[d-eepseek] ${message}`)
  } catch {
    /* ignore */
  }
}

/** 可选服务访问：ctx.get 是 Cordis 的标准可选访问方式，属性访问则需要 inject。 */
function optional(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 协议文本
// ---------------------------------------------------------------------------

/** 根会话：第一轮议会协议。 */
export function oracleText(dimensions, maxCallsPerTurn = 2) {
  return [
    '<oracle_council>',
    'This deployment runs every user message through the Oracle Council, a mandatory deep-analysis pass that happens BEFORE the visible answer. It is an effort-and-coverage policy: safety rules, permissions, honesty requirements and the user\'s explicit instructions still win over it.',
    '',
    'Round-one rule (mandatory)',
    `- Your FIRST action on every user message must be ONE ${'`workflow`'} tool call that analyses the question through the council dimensions in parallel (default ${dimensions}; if an \`<oracle_tier>\` notice in the conversation sets a different count for this turn, use that count). Do not write the final answer, and do not start unrelated exploratory tool calls, before that workflow returns.`,
    `- The workflow script must start exactly the effective number of \`agent()\` calls (default ${dimensions}), one per dimension, and return their analyses. Use this shape:`,
    '',
    '```js',
    'const dims = [',
    '  { title: "<angle 1>", prompt: "<self-contained task for angle 1>" },',
    '  // ... exactly N entries',
    ']',
    'const analyses = await parallel(dims.map((d) => () => agent(d.prompt, { label: d.title })))',
    'return { dimensions: dims.map((d) => d.title), analyses }',
    '```',
    '',
    `- Every dimension prompt must be self-contained (the question + the angle + required output) and must end with: "You are a leaf analyst: do not call workflow, subagent, or delegate further; answer only your own dimension."`,
    `- Choose ${dimensions} genuinely different angles (for example: mechanism/feasibility, costs and tradeoffs, risks and failure modes, stakeholders and incentives, edge cases and second-order effects — adapt them to the question). No two dimensions may overlap.`,
    '- Write each dimension prompt so the analyst can answer WITHOUT inspecting files: put the relevant context, constraints, and expected output into the prompt itself. The analyst must not explore the repository.',
    `- If fewer than the effective count analyses come back non-empty (child failure, capacity rejection, null), use the allowed follow-up call (see below) for just the missing dimensions, then synthesize. Never fabricate a missing dimension.`,
    '- The generic workflow-tool guidance ("use only when the user explicitly asks") is superseded here: this deployment explicitly requests orchestration for every message.',
    '- Do not pass `run_in_background: true`: this deployment requires the foreground council result BEFORE the visible answer.',
    '',
    'Follow-up calls in the same turn (allowed, bounded)',
    'You MAY call workflow a second time in the same turn when, after reading the analyses, either:',
    '  (a) some dimensions came back null, empty, or failed; or',
    '  (b) a genuinely new, orthogonal sub-question appeared that could change the answer and was not covered by any dimension.',
    '- A second call must be narrow: only the missing dimensions, or 1–3 new agents for the new sub-question. Never repeat a dimension that already returned. Announce it with one short line before the call: "补充征询：<missing dimension or new sub-question>".',
    `- At most ${maxCallsPerTurn} workflow calls per turn. A third call is blocked by the harness and returns an error — if the second call also fails, stop and state the gap in the visible answer instead of retrying.`,
    '- Do not call again just to gain confidence or to double-check: put confidence and open questions in the visible answer instead.',
    '',
    'Synthesis (the single visible answer, after the workflow returns)',
    '- First converge, then speak: read all analyses, decide which ONE interpretation/answer is most likely to be right (or the single most useful recommendation), and make that your answer. Do NOT dump a list of per-angle conclusions.',
    '- Mention a rejected alternative only when it would change what the user should do, and keep it to a clause.',
    '- Write like a sharp, lively colleague talking to the user — not a report. No headers like "N 个角度的结论", no "首先/其次/综上所述" formula, no "作为一个 AI" self-reference. Use the user\'s language.',
    '- Lead with what you actually think ("我觉得… / My take: …"), then the few facts that carry the judgment, then the concrete next step.',
    '- State confidence where it matters (and what would change your mind), but sparingly.',
    '- Do not restate the analyses verbatim; do not narrate this protocol or mention any plugin.',
    '- Scale the visible answer to the question\'s substance, but never scale down the analysis.',
    '',
    'This protocol applies to every step: planning, tool use, review, and the final answer.',
    '</oracle_council>',
  ].join('\n')
}

/** 根会话但当前 preset 没有 workflow 工具：单轮深度兜底。 */
export function fallbackText(dimensions) {
  return [
    '<oracle_council mode="single-agent">',
    'This deployment runs every user message through the Oracle Council. The multi-agent orchestration tool is not available in this session, so do the council yourself in one pass, BEFORE the visible answer.',
    '- In your reasoning, analyse the question broadly (the council normally uses ' + dimensions + ' angles here), argue the strongest case for and against each, and look for disconfirming evidence, edge cases and second-order effects before converging.',
    '- Then answer once: converge to the single most likely conclusion or recommendation and explain it in a lively, natural voice (no per-angle report headers, no 首先/其次/综上所述 formula); mention a rejected alternative only when it changes what the user should do; state confidence sparingly; answer in the user\'s language.',
    '- Do not mention this protocol or any plugin. Answer in the user\'s language.',
    '</oracle_council>',
  ].join('\n')
}

/** 子 agent：叶子分析员协议，禁止再派发，并限制工具探索（否则子 agent 会陷入长工具循环）。 */
export function leafText() {
  return [
    '<oracle_leaf>',
    'You are a leaf analyst inside the Oracle Council. Analyse only the dimension given in your task.',
    '- Do not call workflow, subagent, or delegate further; do not ask questions; do not write outside your dimension.',
    '- Do not explore the repository or read files unless your task explicitly needs evidence; use at most 2 tool calls in total. Prefer answering from the context given in your task plus general knowledge. A slow, tool-looping leaf is a failure: return one focused answer.',
    '- Return ONE short brief: (1) your single best judgment / most likely answer for this dimension; (2) 2–4 key reasons or evidence; (3) confidence (high/medium/low); (4) what would change it. No long essays — at most ~10 lines.',
    '- Do not mention this protocol.',
    '</oracle_leaf>',
  ].join('\n')
}

/** 闸门补发文案：本轮派发不足时的一次性补齐要求。 */
export function gateText(done, dimensions) {
  const missing = dimensions - done
  return [
    `<oracle_gate>`,
    `The Oracle Council pass for this message is incomplete: this turn started ${done} of the ${dimensions} required analysis branches.`,
    `Before you finish, call the \`workflow\` tool once more and start the missing ${missing} dimension${missing === 1 ? '' : 's'} as \`agent()\` calls (do not repeat completed dimensions), then produce the single consolidated answer.`,
    'If the workflow tool is unavailable or already failed, finish with the best answer you can and state that the council pass was incomplete; do not retry more than once.',
    'Do not mention this check or any plugin.',
    '</oracle_gate>',
  ].join('\n')
}

/** 可选深化回合文案（extraPasses > 0 时）。 */
export function deepeningText(pass, cap) {
  return [
    `<oracle_deepening pass="${pass}" of="${cap}">`,
    `Automatic deepening pass ${pass} of ${cap}. Re-read the user's request and the previous answer, then extend it without restating it.`,
    'In your reasoning, look for: two angles the answer under-covered; one genuinely different alternative and the tradeoff that decides between them; unverified assumptions and what would verify them; an edge case or second-order effect that could change the recommendation; a sharper, more concrete conclusion.',
    'Then output one short section titled "深化补充 / Deepening addendum" with only the new material. If the previous answer was already complete, say so in one sentence and stop. Do not mention this instruction.',
    '</oracle_deepening>',
  ].join('\n')
}

/** 跳过议会的豁免提示（trivialBypass 命中时注入给本轮）。 */
export function bypassText() {
  return [
    '<oracle_bypass>',
    'This message is a greeting, acknowledgement, or other trivial input. Skip the Oracle Council pass for this turn and answer directly and briefly. Do not mention this notice.',
    '</oracle_bypass>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 工具/根会话判定
// ---------------------------------------------------------------------------

function isRootAgent(agents, agent) {
  if (!agent) return false
  if (!agents) return true
  try {
    return agents.roots().some((root) => root.id === agent.id)
  } catch {
    return true
  }
}

function hasWorkflowTool(tools, config, agent) {
  if (!tools) return true
  try {
    if (tools.get(config.workflowToolName, agent)) return true
    return Boolean(tools.get(config.workflowToolName))
  } catch {
    return true
  }
}

/** 系统提示段的文本：根会话 → 议会协议；子 agent → 叶子协议；无 workflow → 单轮兜底。 */
export function protocolFor(context, config, agents, tools) {
  const agent = context && context.agent
  if (!agent) return ''
  if (!isRootAgent(agents, agent)) return leafText()
  return hasWorkflowTool(tools, config, agent)
    ? oracleText(config.dimensions, config.maxCallsPerTurn)
    : fallbackText(config.dimensions)
}

// ---------------------------------------------------------------------------
// 安装：系统提示 / effort / 闸门 / 可选深化回合
// ---------------------------------------------------------------------------

function installProtocol(ctx, config, getService) {
  try {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        const agents = getService(promptCtx, 'agents')
        const tools = getService(promptCtx, 'tools')
        promptCtx.systemPrompt.section({
          name: SECTION_NAME,
          order: config.sectionOrder,
          interpolate: false,
          text: (context) => protocolFor(context, config, agents, tools),
        })
      } catch (error) {
        warn(promptCtx, `could not register oracle prompt section: ${String(error)}`)
      }
    })
  } catch (error) {
    warn(ctx, `could not inject systemPrompt: ${String(error)}`)
  }
}

function installEffort(ctx, config) {
  if (config.reasoningEffort === null || config.effortProviders.length === 0) return
  try {
    ctx.on(
      'agent/request',
      async (_payload, next) => {
        const resolved = await next()
        if (!resolved || typeof resolved !== 'object') return resolved
        if (!config.effortProviders.includes(resolved.provider)) return resolved
        if (resolved.reasoningEffort === config.reasoningEffort) return resolved
        return { ...resolved, reasoningEffort: config.reasoningEffort }
      },
      { prepend: true },
    )
  } catch (error) {
    warn(ctx, `could not register effort waterfall: ${String(error)}`)
  }
}

/** 从用户消息里取文本（用于 trivialBypass 判定）。 */
function firstUserText(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    if (!message || message.role !== 'user') continue
    if (message.source && message.source.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

const TASK_HINTS =
  /[?？]|帮我|请问|请帮|写|做|查|搜|分析|解释|改|修|实现|设计|评估|对比|推荐|优化|迁移|部署|为什么|如何|怎么|是否|\bhelp\b|\bwrite\b|\bmake\b|\bfind\b|\bsearch\b|\banaly[sz]e\b|\bexplain\b|\bimplement\b|\bfix\b|\bdesign\b|\bevaluate\b|\bcompare\b|\bwhy\b|\bhow\b|\bwhat\b|\bcan you\b/i

/** 极短寒暄类消息：仅当 trivialBypass 开启时生效。 */
export function isTrivial(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  if (trimmed.length > TRIVIAL_MAX_CHARS) return false
  return !TASK_HINTS.test(trimmed)
}

// ---------------------------------------------------------------------------
// 自动分档（autoTier）：按消息复杂度选 7 / 10 / 15 个子 agent
// ---------------------------------------------------------------------------

export const TIER_COUNTS = Object.freeze({ quick: 7, standard: 10, deep: 15 })

/** 复杂/高风险问题的关键词（中文 + 英文）。 */
const DEEP_HINTS =
  /(架构|迁移|重构|不可逆|安全|合规|法务|事故|故障|根因|预算|长期|权衡|取舍|评审|治理|战略|选型|风险|回滚|部署|性能|一致性|测试策略|详细|全面|深入|对比|评估|分析|规划|\barchitecture\b|\bmigrat\w*\b|\brefactor\w*\b|\btrade-?off\w*\b|\brisk\w*\b|\bincident\b|\bsecurity\b|\bcomplian\w*\b|\bstrategy\b|\breview\b|\bevaluat\w*\b|\bdesign\b|\bperf(ormance)?\b|\brollback\b|\bdeploy\w*\b)/i

/**
 * 按用户消息文本选一档议会规模：
 *  - quick(7)：短、单问句、无复杂关键词 —— 寒暄、确认、单点事实/小改动；
 *  - standard(10)：默认；
 *  - deep(15)：长文、多个高风险/权衡关键词，或复合并发问 —— 架构/迁移/事故/安全/选型等。
 * 纯确定性规则，无模型调用，可离线测试。
 * @param {unknown} text 用户消息文本。
 * @returns {{label: 'quick'|'standard'|'deep', count: number}}
 */
export function chooseTier(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const chars = trimmed.length
  const questionMarks = (trimmed.match(/[?？]/g) ?? []).length
  const deepHits = (trimmed.match(new RegExp(DEEP_HINTS.source, 'gi')) ?? []).length
  let label = 'standard'
  if (chars > 180 || deepHits >= 2 || (deepHits >= 1 && questionMarks >= 2)) label = 'deep'
  else if (chars <= 40 && questionMarks <= 1 && deepHits === 0) label = 'quick'
  return { label, count: TIER_COUNTS[label] }
}

/** 本轮档位通知：随 pre-step 注入，告诉模型本轮实际用几路。 */
function tierText(tier) {
  return [
    `<oracle_tier count="${tier.count}" label="${tier.label}">`,
    `This turn's council is auto-tiered to "${tier.label}": use exactly ${tier.count} agent() calls (not the default count).`,
    tier.label === 'deep' ? 'This question is complex or high-stakes: make the dimensions genuinely orthogonal, and keep convergence honest.' : '',
    tier.label === 'quick' ? 'This question is simple: still converge to one answer, and keep the visible reply short.' : '',
    'Do not mention this notice.',
    '</oracle_tier>',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/** 用正则从 workflow 工具结果里数 agent 数（渲染文本：completed (N agents)）。 */
export function countDispatched(result) {
  if (!result || result.isError) return undefined
  const texts = []
  for (const block of result.content ?? []) {
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  const match = /completed\s*\((\d+)\s+agents?\)/i.exec(texts.join('\n'))
  if (!match) return undefined
  const count = Number.parseInt(match[1], 10)
  return Number.isFinite(count) ? count : undefined
}

/**
 * 后台受理（run_in_background: true）的识别：协议已明令禁止，但模型仍可能这么写。
 * 后台 run 不会返回 `completed (N agents)`，若按 0 计算会触发闸门重复派发、双倍烧钱；
 * 这里视为已派发，让闸门放行（宁可不在第一轮强制，也不重复启动一轮）。
 */
export function isBackgroundAccepted(result) {
  if (!result || result.isError) return false
  for (const block of result.content ?? []) {
    if (block && block.type === 'text' && typeof block.text === 'string' && /started in the background/i.test(block.text)) {
      return true
    }
  }
  return false
}

function installGate(ctx, config, getService) {
  const states = new Map()
  const agents = getService(ctx, 'agents')
  const tools = getService(ctx, 'tools')
  const workflowName = config.workflowToolName

  function stateFor(agent) {
    let state = states.get(agent.id)
    if (!state) {
      state = {
        turn: undefined,
        started: false,
        dispatched: 0,
        nudged: 0,
        bypass: false,
        calls: 0,
        required: config.dimensions,
      }
      states.set(agent.id, state)
    }
    return state
  }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (!decision || decision.kind !== 'enter') return decision
      const agent = payload && payload.agent
      if (!agent) return decision
      try {
        let state = stateFor(agent)
        if (state.turn !== payload.turn) {
          state.turn = payload.turn
          state.started = false
          state.dispatched = 0
          state.nudged = 0
          state.bypass = false
          state.calls = 0
          state.required = config.dimensions
        }
        if (payload.step === 1) {
          state.started = true
          const text = firstUserText(decision.messages)
          if (config.trivialBypass && isTrivial(text)) {
            state.bypass = true
            return { ...decision, messages: [...decision.messages, userMessage(bypassText(), 'Oracle bypass: trivial message')] }
          }
          if (config.autoTier) {
            const tier = chooseTier(text)
            state.required = tier.count
            return {
              ...decision,
              messages: [...decision.messages, userMessage(tierText(tier), `Oracle tier: ${tier.label} (${tier.count})`)],
            }
          }
        }
      } catch (error) {
        warn(ctx, `pre-step tracking failed: ${String(error)}`)
      }
      return decision
    })
  } catch (error) {
    warn(ctx, `could not register pre-step listener: ${String(error)}`)
  }

  try {
    ctx.on('tools/result', (exec, result) => {
      try {
        if (!exec || !exec.agent || exec.name !== workflowName) return
        const state = states.get(exec.agent.id)
        if (!state || !state.started) return
        if (isBackgroundAccepted(result)) {
          // 后台 run 没有 completed 计数；按已派发放行，避免闸门重复启动一轮
          state.dispatched = Math.max(state.dispatched, state.required)
          return
        }
        const count = countDispatched(result)
        if (count !== undefined) state.dispatched += count
      } catch (error) {
        warn(ctx, `tools/result tracking failed: ${String(error)}`)
      }
    })
  } catch (error) {
    warn(ctx, `could not register tools/result listener: ${String(error)}`)
  }

  try {
    // 同回合多次调用的硬上限：协议允许"主调用 + 一次补充"，第 3 次由这里拦下。
    // 放在 pre-execute（而不是提示词）里，模型无法绕过。
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      try {
        if (!exec || !exec.agent || exec.name !== workflowName) return decision
        const state = states.get(exec.agent.id)
        if (!state || !state.started || state.bypass) return decision
        if (decision.kind !== 'allow') return decision
        if (state.calls >= config.maxCallsPerTurn) {
          return {
            kind: 'deny',
            reason:
              `Oracle: workflow call limit reached (${config.maxCallsPerTurn} per turn). Do not call workflow again this turn — ` +
              'synthesize from the analyses you already have and state any remaining gap in the visible answer.',
            info: { name: 'OracleCallLimit', code: 'ORACLE_CALL_LIMIT' },
          }
        }
        state.calls += 1
        return decision
      } catch (error) {
        warn(ctx, `pre-execute call limit failed: ${String(error)}`)
        return decision
      }
    })
  } catch (error) {
    warn(ctx, `could not register pre-execute listener: ${String(error)}`)
  }

  try {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      try {
        if (!agent || !isRootAgent(agents, agent)) return
        if (!hasWorkflowTool(tools, config, agent)) return
        if (signal && signal.aborted) return
        const state = states.get(agent.id)
        if (!state || !state.started || state.turn !== turn || state.bypass) return
        const required = state.required ?? config.dimensions
        if (state.dispatched >= required) return
        if (state.nudged >= config.gateRetries) return
        const pending = agent.inbox && agent.inbox.nextTurn
        if (Array.isArray(pending) && pending.length > 0) return
        state.nudged += 1
        await agent.followup(
          userMessage(gateText(state.dispatched, required), `Oracle gate ${state.nudged}/${config.gateRetries}`),
        )
      } catch (error) {
        warn(ctx, `gate follow-up failed: ${String(error)}`)
      }
    })
  } catch (error) {
    warn(ctx, `could not register gate listener: ${String(error)}`)
  }

  try {
    ctx.on('agent/disposed', ({ agent }) => {
      if (agent) states.delete(agent.id)
    })
  } catch {
    /* ignore */
  }
}

function installExtraPasses(ctx, config, getService) {
  if (config.extraPasses === 0) return
  const agents = getService(ctx, 'agents')
  const used = new Map()

  try {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (!agent) return
      if (message && message.source && message.source.kind === 'user') used.set(agent.id, 0)
    })
  } catch {
    /* ignore */
  }

  try {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      try {
        if (!agent || !isRootAgent(agents, agent)) return
        if (signal && signal.aborted) return
        const pending = agent.inbox && agent.inbox.nextTurn
        if (Array.isArray(pending) && pending.length > 0) return
        const spent = used.get(agent.id) ?? 0
        if (spent >= config.extraPasses) return
        used.set(agent.id, spent + 1)
        await agent.followup(
          userMessage(deepeningText(spent + 1, config.extraPasses), `Oracle deepening pass ${spent + 1}/${config.extraPasses}`),
        )
        void turn
      } catch (error) {
        warn(ctx, `deepening pass failed: ${String(error)}`)
      }
    })
  } catch {
    /* ignore */
  }

  try {
    ctx.on('agent/disposed', ({ agent }) => {
      if (agent) used.delete(agent.id)
    })
  } catch {
    /* ignore */
  }
}

const REQUIRED_SERVICES = ['systemPrompt']

/** Cordis 依赖声明：systemPrompt 是硬依赖；agents/tools 通过可选访问读取。 */
export const inject = REQUIRED_SERVICES

/**
 * Cordis 插件入口。
 * @param ctx 插件自身的作用域上下文（注册随插件卸载一起释放）。
 * @param rawConfig 该行的 config（无 Config schema 时原样传入）。
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  if (!config.enabled) return

  const getService = (scope, name) => {
    try {
      const direct = scope[name]
      if (direct !== undefined) return direct
    } catch {
      /* 未 inject 的服务属性访问会抛错，退回 ctx.get */
    }
    return optional(scope, name)
  }

  installProtocol(ctx, config, getService)
  installEffort(ctx, config)
  installGate(ctx, config, getService)
  installExtraPasses(ctx, config, getService)
}

apply.inject = REQUIRED_SERVICES
export default { apply, inject: REQUIRED_SERVICES }

# D-------eepSeek（`dsh-d-eepseek`）

给 **DeepSeek Harness** 的 Host-only 插件：把"深度思考"从**回合结束后的补课**改成**第一轮思考内的前置动作**。

一条用户消息 → 第一轮里先并行派发 N 路子 agent（默认 10；开启 `autoTier` 后按消息难度在 **7 / 10 / 15** 间自动选）→ 结果返回后**先收敛出一个最可能的结论**，再只输出一版综合答案。默认不再追加"第二轮深化"，所以不会出现"先答一版浅的、再补一版深的"两段式观感。

答案的语气也改了：不要"五个角度的结论"这种报告腔，而是像同事聊天一样先给"我觉得…/My take: …"，再把支撑判断的关键事实讲清楚；只在会改变行动时才提被否掉的替代方案。

> 显示名按你要求**照字面**为 `D-------eepSeek`；包名是 npm 安全形式 `dsh-d-eepseek`，row id `d-eepseek`。

## 安装

- **GitHub（发布后）**：DSH 插件面板 → 添加插件 → 填 `github:YDreamLess520/D------eepSeek-DSH-Plugin`（可加 `#v0.4.0` 固定版本）。
- **本地目录**：解压分发包，填含 `package.json` 的那个 `dsh-d-eepseek` 目录的绝对路径。
- **npm**：去掉 `private: true` 并 `npm publish` 后，填包名 `dsh-d-eepseek`。

装完**必须**按下面「装完必做」把并发容量调到 20。

## v0.4.0 变更（2026-10-24）

- **同回合允许二次调用**：一次思考里，主 agent 跑完主议会后，**允许再调用一次** `workflow` 做补充（默认上限 **2 次/回合**，可用 `maxCallsPerTurn` 调到 1..3）。
- **第三次调用被硬拦**：不是靠提示词，而是 `tools/pre-execute` 硬闸门直接 deny（错误码 `ORACLE_CALL_LIMIT`）。
- **补充调用的合法理由只有两类**：① 某些维度返回 null/空/失败 → 只补缺失维度；② 读结果后出现**新的正交子问题**且可能改变答案 → 只加 1–3 个 agent。不允许重复已回答的维度，也不允许"只为多要一点信心"再跑一轮；补充调用前要先写一句 `补充征询：<…>`。
- 第二次调用后仍失败就停，在答案里说明缺口，不允许第三次。

## v0.3.0 变更（2026-10-24）

- **自动分档（autoTier）**：按消息复杂度自动把本轮议会规模定成 **7 / 10 / 15**，每轮通过一条 `<oracle_tier count="N">` 通知告诉模型实际路数，闸门也按该档位判定。
  - **7（quick）**：≤40 字、≤1 个问句、无复杂/高风险关键词 —— 寒暄、确认、单点小问题；
  - **10（standard）**：默认档；
  - **15（deep）**：>180 字，或命中 ≥2 个高风险关键词（架构/迁移/回滚/安全/事故/选型/权衡/评估…），或 ≥1 个关键词 + 多个问句。
- 代码默认 `autoTier: false`；**本机 bundle patch 已设为 true**，想关掉就把这一行改回 false。
- 纯确定性规则（无模型调用），离线可测。

## 装完必做：调高子 agent 并发容量

DSH 默认只允许同时存在 **8** 个子 agent（`subagent.maxActiveSubagents`），而本插件默认档位是 **10**、自动分档最高 **15**。不改这个值，超出的子 agent 会排队/被拒，答案会"变窄变浅"，但不一定报错——所以装完第一件事就是把它调到 **20**。

在**运行插件的那个 profile** 的 `cordis.patch.yml` 末尾加上（按 id 覆盖会**整块替换** config，所以要保留你原来的 `maxDepth`）：

```yaml
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxDepth: 3              # 保留你原来的值（本机是 3；没自定义过就删掉这行）
    maxActiveSubagents: 20   # 默认 8；建议 20 = 15 档 + 余量
```

- **验证**：发一条复杂问题（触发 15 档），工具卡应显示 `completed (15 agents)`、会话里出现 15 个子会话；若只看到 8 个，说明 profile 没重载或你改错了 profile。
- **不想改配置的最低配**：自动分档的 **7 档**恰好 ≤ 8，能正常跑；10/15 档会被压到 8 路水平。
- Desktop 与 CLI 可能各用各的 profile——要在实际跑插件的那个 profile 里改，改完重启/重载 DSH Desktop 使其生效。

## v0.2.0 变更（2026-10-24）

- **子 agent 数**：默认 **10**，范围 **7..15**（"Agent 个数"指除总 agent 外的子 agent）。
- **子 agent 输出**：从"结构化清单"改成「单一最佳判断 + 2–4 条关键理由 + 置信度 + 什么会改变它」。
- **综合方式**：主 agent 必须先从多份分析里**收敛出一个最可能的结论**，不再输出"N 个角度的结论"式报告。
- **回答语气**：像活泼的同事聊天，先给"我觉得…"，再讲支撑判断的关键事实；只在会改变行动时才提被否掉的替代方案。
- **并发容量**：安装后必须先按上文「装完必做：调高子 agent 并发容量」把 `subagent.maxActiveSubagents` 调到 20；最低可用是 7 档（≤ 默认 8）。

## 一条消息发生了什么

```
用户消息
  → 系统提示（根会话）注入议会协议：第一个动作必须是 workflow 调用，
    并行启动 N 个 agent()，每个 agent 独立分析一个维度，结果返回前不得写最终回答
  → 子 agent 拿到的是「叶子分析员」协议：只分析自己的维度，禁止再派发（防递归）
  → workflow 返回 N 份分析
  → 主 agent 输出唯一一版综合答案：先收敛出最可能的结论，再像同事聊天一样讲清
    关键事实、置信度与下一步
  → 回合结束前闸门检查：本轮 workflow 结果里的子 agent 数 < 本轮档位 N？
        ├─ 是（且没用过补发）→ 追加一次 followup 要求补齐，之后无论如何放行
        └─ 否 → 正常结束
```

**为什么是第一轮**：`workflow` 调用发生在模型写回答之前（工具结果回来前协议禁止作答），深挖的 token 花在"第一轮思考"里，而不是等回合结束后再开新回合。

## 与旧插件的关系

本插件是原 `dsh-deep-deliberation` 的合并升级版：

| 能力 | 旧插件 | 本插件 |
|---|---|---|
| 深度推演协议 | ✅ 系统提示注入 | ✅ 并入议会协议 |
| 强制 max reasoning effort | ✅ | ✅ 保留 |
| 回合结束后自动深化 | ✅ 默认每轮一次（两段式） | ⚙️ 默认 **0**，`extraPasses` 可开 |
| 第一轮并行多维度深挖 | ❌ | ✅ 默认 10 路（7..15，可自动分档） |
| 闸门防漏派发 | ❌ | ✅ 一次性补发（`gateRetries`） |

旧插件 `dsh-deep-deliberation` 已从 profile 卸载；其源码目录保留在 `plugins/dsh-deep-deliberation/` 作为历史参考。

## 配置（profile 的 `cordis.patch.yml` 按 row id 覆盖）

```yaml
- id: d-eepseek
  name: dsh-d-eepseek
  config:
    dimensions: 10       # 7..15，默认档/上限判定的基准（默认 10；调到 15 更贵）
    gateRetries: 1       # 0..2，本轮派发不足时最多补发几次（默认 1；0 = 不补）
    extraPasses: 0       # 0..3，综合后再追加的深化回合（默认 0）
    reasoningEffort: max # off|low|high|max|false（默认 max；false = 不改请求）
    trivialBypass: false # true 时极短寒暄（<8 字且无任务/疑问）跳过议会
    autoTier: true       # true 时按消息难度自动选 7/10/15；false = 固定用 dimensions
    maxCallsPerTurn: 2   # 同一回合最多几次 workflow 调用（1..3；第 3 次硬拦）
```

- `autoTier: true`（本机已开）时：简单问题 7 路、普通 10 路、复杂/高风险 15 路；关掉后每条消息都用 `dimensions`。
- **并发容量**：DSH 子 agent 容量 `subagent.maxActiveSubagents` 默认只有 8，跑 10 路前必须把它调高（本机 profile 已设为 20）。否则超出的子 agent 会被 `ACTIVATION_LIMIT_REACHED` 拒绝，协议会尝试补跑缺失维度，但会变慢。
- 想关掉整套效果：`enabled: false`；想卸载：设置 → 插件 → 卸载 `dsh-d-eepseek`。
- 其它可选字段：`effortProviders`（默认 `['deepseek-account']`）、`workflowToolName`（默认 `workflow`）、`sectionOrder`（默认 10300）。

## 硬边界（防失控）

- **每轮最多一次补发**：`gateRetries` 上限 2；补发后无论结果如何都放行，不循环。
- **workflow 调用次数硬上限**：同一回合最多 `maxCallsPerTurn` 次（默认 2）；超出由 `tools/pre-execute` 直接拒绝，不依赖模型自律。
- **不追溯**：只对"插件看到过本轮第一个 step"的回合生效；安装/热更时已经在进行的回合不会被补课。
- **子 agent 不触发议会**：提示段按 agent 的根/子身份切换成叶子协议；DSH 的 `maxDepth` 默认 1 再加一层限制。
- **让位**：用户已排下一句（`inbox.nextTurn` 非空）或取消信号已触发时，闸门不补发。
- **停止即停**：前台 workflow 的取消会级联中止 PTC 进程与所有子 agent（契约已核实）。
- **没有整体超时**：单条消息可能跑几十秒到几分钟；停止按钮是唯一的中断方式（`workflow` 无 elapsed deadline）。

## 实测数据（本机 2026-10-24，真实 `workflow` 运行）

**第一次运行（叶子协议未收紧，子 agent 会自行翻仓库）**

| 项 | 数值 |
|---|---|
| 子 agent 数 | 5（工具卡文本 `completed (5 agents)`） |
| 子会话墙钟 | 21s / 28s / 190s / 305s / 478s |
| 子 agent 工具调用 | 55 / 51 / 65（另两个 0） |
| 子 agent 输出 tokens | 2.9k / 4.1k / 21k / 38.5k / 42.3k |
| 整条消息墙钟（父 turn） | **≈571s（约 9.5 分钟）** |
| 父+子总输出 tokens | ≈121.7k；计入缓存读取 ≈14.7M |

**第二次运行（收紧叶子协议：不翻仓库、工具调用 ≤2）**

| 项 | 数值 |
|---|---|
| 子 agent 数 | 5（`completed (5 agents)`） |
| 每个子 agent | 1 条 assistant、0 次工具调用 |
| 单子会话墙钟 | 17–31s |
| 单子 agent tokens | 13.5k–15.5k（输入 ~10k / 输出 2.4–4.4k） |
| 整条消息墙钟（父 turn） | **≈50s** |
| 父+子 tokens | 输入 ≈58.5k、输出 ≈18.5k；计入缓存读取 ≈1.63M |
| 结构校验 | 子会话均为 1 个 turn、0 个孙会话 |

**第三次运行（v3：默认 10 路 + 子 agent 只给"单一最佳判断"）**

| 项 | 数值 |
|---|---|
| 子 agent 数 | 10（`completed (10 agents)`，容量上限已调到 20） |
| 每个子 agent | 1 条 assistant、0 次工具调用 |
| 单子会话墙钟 | 7.9–12.6s |
| 单子 agent tokens | 12.0k–13.0k（输入 ~10k / 输出 0.9–1.8k） |
| 父+子 tokens | 输入 ≈80.2k、输出 ≈22.1k；计入缓存读取 ≈7.16M |
| 结构校验 | 10 个子会话均为 1 turn、0 个孙会话 |

**结论**：限制叶子工具循环是延迟与成本的命门——同一机制从 ~10 分钟/121.7k 输出降到 ~50s/18.5k 输出（≈6.6×）。而叶子改成"单一最佳判断 + 关键理由"后，10 路并没有把输出翻倍（22.1k vs 5 路的 18.5k），因为每个子 agent 从 2.4–4.4k 压到 0.9–1.8k；并行子任务只要 8–13s，真正的成本转移到了父 agent 的合成与历史增长上。

验证工具（本目录 `tools/`）：
- `aggregate-usage.mjs`：父+子会话 usage/墙钟聚合（上面的数字来自它）；
- `scan-sessions.mjs`：扫描近期会话的 system prompt 与标记；
- `session-prompt-check.mjs`：确认会话日志里出现 `<oracle_council>`（marker 已切到新插件）。

## 已知限制

- **协议是软约束**：真正硬保障只有闸门的一次性补发；模型可能少派，闸门补一次后仍放行。不存在 DSH 层的"回答前强制工具调用"钩子。
- **叶子工具循环是最大延迟源**：协议已限制"不要翻仓库、≤2 次工具调用"，但仍是 Prompt 级；实测未收紧时会从 ~50s 恶化到 ~10 分钟。
- **子会话会进父会话的后代目录**：DSH 把本地子会话写入 `subagent/catalog`，每条消息 +N 条记录，插件侧无法隐藏（客户端行为）。
- **默认 N=10 + 每条消息触发**：寒暄/追问也跑 10 路；想省钱用 `dimensions: 7` 或 `trivialBypass: true`。
- **并发容量**：`subagent.maxActiveSubagents` 默认 8 < 10，未调高时会有子 agent 被拒；本机已在 profile patch 设为 20。对外分发时务必在 INSTALL 里提醒。
- **后台模式**：协议禁止 `run_in_background`；若模型仍用，闸门按"已派发"放行以避免重复烧钱，但"结果先于回答"的保证失效。
- **递归**：叶子协议禁止再派发，但本机 profile 把 `subagent.maxDepth` 设为 3，且 workflow 分支不受该深度限制；要更硬需在 harness 层裁剪子 agent 工具。
- **preset 覆盖**：本插件是宿主级。`standard`/`cordis` 有 `workflow` 工具（正常）；`ptc` 禁用 workflow 行、`minimal` 没有 workflow → 自动降级为单轮深度协议且闸门跳过。无"按 preset 开关"能力（只能全局 `enabled: false`）。
- **与 effort 滑条冲突**：插件在请求层强制 `max`；`dsh-codex-effort-slider` 拖到 Off/Low 时实际请求仍是 max（UI 会"说谎"）。想交给 UI 就设 `reasoningEffort: false`。
- 非 `deepseek-account` 路由不改 effort；运行中改源码不会热更（需重启或换新路径重装）。
- 安装/卸载实验在 profile `node_modules` 留下的失效 junction 已清理。

## 文件

```
plugins/dsh-d-eepseek/
  index.js            ← 唯一运行时代码（零依赖、无构建）
  package.json
  cordis.patch.yml    ← bundle patch：插入 row + 默认 config
  locale/{en,zh}.json
  icon.svg
  README.md
  test/plugin.test.mjs
  tools/aggregate-usage.mjs
  tools/scan-sessions.mjs
  tools/session-prompt-check.mjs
```

## 与旧插件的迁移

- 旧 row `deep-deliberation` / 旧字段 `level` 不再生效；新 row 是 `d-eepseek`，深度用 `dimensions`。
- 旧插件 `dsh-deep-deliberation` 已从 profile 卸载；源码目录保留在 `plugins/dsh-deep-deliberation/` 作为历史参考，可删除。
- 旧的 `extraPasses: 1` 默认值变为 `0`（两段式深化默认关闭），需要时再开。

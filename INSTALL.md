# 安装 / 分发给其他 DSH 用户

这是一个 **Host-only bundle**：零依赖、无构建步骤，复制目录即可用。

## 对方需要什么

| 要求 | 说明 |
|---|---|
| DSH 版本 | 本插件在 `0.2.1-rc.2`（Desktop）上开发并实测；更早/更晚版本未验证 |
| agent preset | 需要能看见 `workflow` 工具的 preset（本机 `cordis`/`standard` 有）。没有时会自动降级为"单轮深度"协议，不会派发议会 |
| **并发容量** | 必须把 `subagent.maxActiveSubagents` 调到 ≥ 想用的 `dimensions`（默认只有 8，10 路会拒掉 2 个）。见下方配置片段 |
| provider | `reasoningEffort` 强制只对 `deepseek-account` 生效；其它路由原样放行（可配 `effortProviders`） |
| 权限 | 无额外要求（不改审批、不写工作区外文件） |

## 安装（三种方式，按省事程度排序）

1. **本地目录（推荐给压缩包接收方）**
   - 解压后得到 `dsh-d-eepseek/` 目录；
   - DSH Desktop → 设置 → 插件 → 添加插件 → 填该目录的**绝对路径** → 安装；
   - Host 插件安装后通常立即生效；若界面没变化，完全退出重开 DSH Desktop 一次。
2. **GitHub（把本目录内容推到仓库根即可）**
   - 插件面板填 `github:YDreamLess520/D------eepSeek-DSH-Plugin`；要求 `package.json` 在仓库根。
3. **npm（需先发布）**
   - 去掉 `package.json` 的 `"private": true`，`npm publish` 后，面板填包名 `dsh-d-eepseek`。

> 只复制本目录（源码），不要复制 `plugins/runtime/*` 这类部署副本，也不要复制 profile 里 `node_modules` 的 junction。

## 装完先做两件事

**1）把子 agent 并发容量调高**（否则 10-15 路会有一部分被拒）。在对方 profile 的 `cordis.patch.yml` 里加/改：

```yaml
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxActiveSubagents: 20   # 默认 8；至少要 >= dimensions
```

**2）按需要调议会规模**。当前默认是 **每条消息 10 路议会**（连"你好"也会跑 10 个子 agent，单条约 1 分钟、消耗大）。给别人用建议从最小档开始：

```yaml
- id: d-eepseek
  name: dsh-d-eepseek
  config:
    dimensions: 7        # 范围 7..15，默认 10；7 是最省的一档
    gateRetries: 1
    extraPasses: 0
    trivialBypass: true  # "你好/收到"这类极短消息不跑议会
```

`dimensions` 就是"除总 agent 外的子 agent 个数"。每 +1 路大约多一份子 agent 的输出成本和一点墙钟；15 路最贵。

> 包里默认开启 `autoTier: true`：简单消息自动 7 路、普通 10 路、复杂/高风险 15 路（纯规则判定，见 README）。想让每条消息固定用 `dimensions`，把 `autoTier` 设为 `false`。
>
> 同一回合默认最多调用 **2 次** workflow（主议会 + 1 次补充），第 3 次会被硬拦（`ORACLE_CALL_LIMIT`）；不想允许补充调用就设 `maxCallsPerTurn: 1`。

## 卸载

设置 → 插件 → 卸载 `dsh-d-eepseek`（会释放提示段与所有监听器，不会在会话里留下自定义事件）。

## 已知限制（务必转告）

- 协议是 **Prompt 级软约束**，硬保障只有"闸门一次性补发"；模型仍可能少派。
- 每条消息会新增 N 个子会话（会进父会话的后代目录），会话记录会变长。
- 输出语气按"先收敛到一个最可能结论、像同事聊天"的要求改写；如果对方更想要报告体，改 `index.js` 里的 Synthesis 段即可。
- 与 effort 滑条类插件冲突：本插件在请求层强制 `max`，滑条拖低实际仍走 max；想交给滑条就把 `reasoningEffort` 设为 `false`。
- 子 agent 禁止翻仓库这一点同样是 Prompt 约束；若对方遇到单条消息跑很久，优先检查子 agent 是否在长工具循环（可在协议里继续收紧）。
- 本插件是宿主级、对所有会话生效；没有按 preset 的开关。

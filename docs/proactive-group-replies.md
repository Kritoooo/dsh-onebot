# 原生决策模型驱动的主动群聊

`0.9.19-kirito.4` 新增，`.5` 增加有界沉默加分，`.6` 增加统一机器人名字来源；默认关闭。启用后的默认模式是 shadow：只调用决策 API，记录概率、模型与用量，不调用回复模型、不发 QQ 消息。决策 provider 与现有 dsh 回复模型独立。

## 配置

编辑 profile patch 中 `dsh-onebot` 的 config；保存沿用宿主配置热加载。专用 QQ 设置面板暂未增加这些嵌套字段，原生配置入口或文件可编辑。关闭 `proactive.enabled` 即停止旁听和主动回复；`/silent`、`/stop`、`/new` 也会使已有待发内容失效。

```yaml
requireMention: true
botName: '' # 留空自动读取 QQ；也可在「机器人名字」中配置
proactive:
  enabled: true
  shadow: true
  groups: ['461351533']
  ignoredUsers: [] # 可填其他机器人 QQ
  botProfile: '昵称是机器人。像自然的群友，会接梗，也能认真帮忙。'
  decision:
    provider: openrouter
    model: google/gemini-decision-1
    apiKeyEnv: OPENROUTER_API_KEY
    timeoutMs: 3000
```

实际密钥只放服务的受保护环境文件，例如服务器已有 `/etc/dsh/dsh.env`；`apiKeyEnv` 填环境变量名。修改服务环境后需按该服务的流程重启。不要把密钥填进配置、仓库、群消息或日志。

配置 `groups` 是主动回复的独立白名单，仍受原有 `groupPolicy` / `groupAllowFrom` 约束；空列表不旁听，最多 128 个群。其他机器人可放进 `ignoredUsers`。默认自己发出的消息只作为背景，不触发新回合。

## Provider

| provider | 默认完整端点 | 默认模型 | 默认凭据变量 |
| --- | --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-1.14.0` | `TYPESAFE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.14` | `OPENROUTER_API_KEY` |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `systemone` | 必填 `endpoint` | 必填 `model` | 必填 `apiKeyEnv` |

`endpoint` 是完整 HTTPS URL，不是 base URL，不带用户名、密码、查询参数或 fragment。`systemone` 接受相同的原生请求/响应契约，供其他兼容的决策 provider 使用。所有 provider 都发送 `model/state/questions`，只接收原生 Noul/Choice；不调用聊天 completions，不解析生成式 JSON，不配置语言模型 fallback，不自动重试失败请求。更换 provider/model 后应重新评估阈值。

契约核对于 2026-11-13：[TypeSafe](https://docs.typesafe.ai/api/system-one)、[OpenRouter](https://openrouter.ai/blog/insights/what-is-jev/)、[Vercel TypeSafe-compatible](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)。模型可用性、权限和账单以所选 provider 账户为准。

## 决策与上下文

@ 或经 `get_msg` 校验的引用回复直接走原流程。其他消息先通过既有访问/去重检查，再进入每群独立的短期缓冲：最多 40 条、10 分钟；文字每条最多 800 字符，媒体仅保留标记，不下载或识别。纯媒体不触发主动回合。

最后一条后等待 3 秒，一批最多等 8 秒；同群决策至少间隔 8 秒。每次选最新的未提交候选消息，给决策器最近 12 条及最多 3 层已在缓冲中的引用。QQ 号替换为本请求局部的 `u0/u1`，消息 ID 替换为 `m0/m1`；昵称和必要原文仍会传给选定 provider。

一轮原生请求并行判断：是否在找机器人、是否欢迎其他人参与、是否有接话价值、是否会打扰，并选择闲聊/帮助/共情/沉默；另判断各条原文与目标话题的相关性。程序按阈值决定是否唤起主模型，不把概率相乘或当成实际准确率。

通过后使用原来的同群 dsh 会话、模型和人设，追加一条带目标消息/发言人、相关原文和各自引用关系的插件消息。已提交给该会话的原文不重复追加；机器人实际发送的内容作为后续判断背景。该回合始终为成员权限，宿主 `tools/pre-execute` 拒绝工具调用，QQ 工具权限即使配置 `all` 也不放行主动回合。

**持久化边界：**相关原文和生成的草稿通过普通 dsh 回合留在会话历史。动态平台提示会提供最近主动回合的发送回执，要求主模型区分已发内容与未发草稿，避免把取消的插话当成群友已读；缺少确认时保持未知。旁听缓冲本身不落盘、重启后重新积累。它不是单次调用后自动丢弃的临时 system prompt，也不代表长期记忆。不同群、私聊互不混用；`/new` 清当前群的旁听缓冲和提交标记。

## 发言节奏与最终复核

| 配置项 | 默认值 |
| --- | --- |
| `cooldownMs` | 120000，每群主动插话间隔 |
| `hourlyLimit` / `dailyLimit` | 6 / 30，滑动 1 小时 / 24 小时 |
| `ttlMs` | 30000，从投递回合起计算的有效期 |
| `addressedThreshold` | 0.85 |
| `invitationThreshold` | 0.8 |
| `valueThreshold` | 0.85 |
| `silenceBoost` | 0.10，接话价值阈值的最大降幅；0 关闭 |
| `interruptionThreshold` | 0.2，上限 |

在找机器人的概率达标，或开放讨论和价值均达标，并且打扰概率不高于上限，才生成。模糊判断保持沉默，等新消息带来新上下文。发送后 90 秒内，最多两轮明确回应机器人的相关跟聊可绕过冷却；仍计入主动额度。每日采用滑动 24 小时，不受服务器时区影响。

沉默加分只调整程序中的 `valueThreshold`，不改变模型原始分数。在最近 10 分钟、上次实际发言后至少观察到 6 条新有效非定向文字时，沉默 5 分钟后开始线性降低阈值，25 分钟达到最大降幅；默认 0.85 → 0.75。硬下限 0.70，原本低于此值的自定义阈值保持原值。重复、纯媒体和指令不增加活跃度，冷群第一条消息不会获得加分；没有新消息时不会因时间经过而主动发言。

任意实际机器人发言（含显式回复）重置沉默计时与活跃度，草稿、失败与影子决策不重置。不同群分别计算；启动、配置重载和 `/new` 从零开始。每轮固定有效阈值并沿用到发送前复核。日志增加 `silenceFactor`（0–1）和 `valueThreshold`，供影子联调比较；addressed/invitation/interruption、冷却和限额保持原规则。

回合中不发中间文字、排队/失败/超时通知。只保留最后一条无工具调用的文字；完成后复核有效期、白名单、静音、撤回、连接和显式请求。生成期间有新消息则再做一次原生决策复核；复核期间又变化时放弃。只发送一条不超过 600 字符的纯文本，`[[不回]]` 保持沉默；不转图、不解析合并转发、不离线补发、不重试。

额度保存在媒体目录的 `proactive-quotas.json`，重启不重置；损坏时主动通道关闭，显式聊天仍可用。发送结果不确定也保守计入额度。控制台只记决策维度、模型和 token 用量，不记完整旁听原文、请求头或上游错误正文。

## 验证与上线

先在一个允许的群启用 shadow，收集真实中文群聊的判断结果，人工核对该回/可回可不回/不该回。关注反话、引用、接梗、多人同时聊天和已有答案。验证 provider 凭据与请求可用后再将 `shadow: false`。本地自动化使用替身 HTTP 服务，不代表真实 provider 的中文准确率或 QQ 已完成上线验证。

## 机器人名字

`.6` 在 QQ 设置页的「连接」组增加「机器人名字」(`botName`)。非空时优先使用配置名；留空按当前群名片 → 当前群昵称 → QQ 登录昵称回退。私聊使用 QQ 登录昵称。每群分别解析，只查询机器人自身资料；缓存 6 小时（`.7` 起），后续聊天会刷新，重连清缓存。查询失败使用尚可用的已有资料，完全未知时不猜名字；等待有界，不让资料接口长期阻塞聊天。

同一份结构化 `botIdentity` 进入决策 API 的 state 与回复模型动态 QQ 上下文，昵称被当作数据，禁用提示词插值。`botProfile` 只保留通用风格，不需要再手填名字。人设的角色名可以与 QQ 显示名称不同；如果希望统一称呼，填写 `botName` 即可。不会修改 QQ 账号昵称、群名片或原有角色提示词，也不会增加关键词硬唤醒；普通文字呼叫仍走决策通道，shadow 下仍只记录。

## 决策模型的机器人身份字段

`.8` 起，state.botIdentity 明确包含机器人自身的 `qq`、`qqNickname`、`groupNickname` 三项；群名片优先于群资料昵称，未知字段不猜测。`name` 仍按配置名字或自动读取的优先级解析。配置名字只决定主要称呼，仍读取机器人自身 QQ 资料以提供这三项；成功缓存保持 6 小时。

决策题目说明要求将原文中的 @QQ号 与 botIdentity.qq 对照，分清“你”指向机器人还是其他群友。没有加入 @其他人的硬拦截，也不扩展其他成员资料或改变触发阈值；判断仍由原生决策模型完成。

`.9` 起，QQ 昵称优先取机器人自己的 get_stranger_info 个人资料，失败时依次回退群成员资料 nickname、登录信息 nickname；避免部分网关登录接口返回占位/过期昵称。群名片与 QQ 昵称独立，仍保持 6 小时成功缓存，只查询机器人自己的资料。

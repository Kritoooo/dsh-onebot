# 决策模型补齐机器人身份三项

## Goal and acceptance

用户报告 message 1175154698 的「@其他人 你呢」误触发。已读取原始 get_msg：真实 at 段目标为 3392750084，机器人自身为 1162955951；00:28:01 决策 addressed≈0.9164、interruption≈0.0975，命中被呼叫分支。现有原文仍保留 @QQ 数字，但 botIdentity 没有自身 QQ 号，模型不能可靠比对。

用户明确要求仅为机器人提供 QQ 号、QQ 昵称、群昵称（群名片优先），由决策模型判断；不增加 @别人的硬拦截，不扩展其他群成员资料，不变更阈值、频控、回复开关与 6 小时缓存。现有配置名字和自动回退优先级保留。

验收：有 selfId 时提供真实机器人 QQ；selfId 未知可从 get_login_info.user_id 回退；账号昵称与群昵称分别提供，配置名不妨碍真实 QQ 获取；三项进入原生决策 state.botIdentity。@他人和 @机器人使用同一协议，只靠模型判断。未知字段不猜测。原消息做离线决策回放，不发送 QQ 测试消息。

## Approach / Progress

1. 变更前源码与现有测试快照保存到本机受保护临时目录，便于行为回归验证。
2. 最小修改 identity 字段和决策字段说明，不新增规则/依赖；更新现有身份与原生请求契约用例。
3. 完成后统一构建、类型、全量测试、打包与补丁恢复验证；回归用例在旧源码上应因缺少 qq/groupNickname 字段失败。
4. 备份并部署新包，保持主动回复开启；真实 provider 回放 @他人与 @自己的两条输入，报告分数与局限，不宣称模型绝无误判。

## Validation

待执行：build、tsc --noEmit、vitest 全量、npm pack、安装包字节核对、旧版回归对照、线上 QQ 身份与原生决策回放、服务/QQ 在线。

## Result

`.8` 只补齐机器人 qq/qqNickname/groupNickname 三项及字段说明，保留 name/source 与配置名字优先；未实施额外 @ 结构化/其他成员资料/硬拦截。成功缓存仍 6 小时，主动回复保持开启。

构建、类型、差异、包内 lib 字节比对、补丁恢复通过。全量 50 文件、862 项通过、5 项跳过；名字 8 项通过。新身份用例在变更前 `.7` 源码副本按预期因缺字段失败。

真实 Gemini BYOK 单条回放：原 @他人输入 addressed≈0.3576、interruption≈0.4346、mode=none，未触发；仅改 @ 为机器人自身 QQ 后 addressed≈0.9275、interruption≈0.0189、casual，触发。每次 1330 输入 token、0 输出，均未发 QQ 消息。此回放不是原完整上下文，不宣称模型以后绝无误判。

01:03 部署 `.8`，服务/QQ 在线/入口鉴权与配置原文对照通过，安装模块与回放模块字节相同；shadow=false 保持。证据和回滚脚本在 `hosts/5o1/services/qq-assistant/changes/2026-11-14-decision-bot-identity/`。复用用户 Netcatty 会话未关闭；源码未提交/推送。目标完成，移入 completed。

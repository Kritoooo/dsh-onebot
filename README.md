# dsh-onebot

> **[English](README.en.md) | 中文**

给 dsh（DeepSeek Harness）提供 QQ 通道的 OneBot 11 插件，支持 SnowLuma、NapCat 等协议端。当前 fork 版本为 **0.9.19-kirito.3**。

用户消息经 QQ 网关进入插件，再交给对应聊天的 dsh Agent；模型回复经插件转换为 QQ 消息。插件负责连接、消息转换与通道访问控制，模型、预设和工作区通过宿主管理或插件配置选择。

## 当前能力

| 类别 | 保留的能力 |
| --- | --- |
| 连接 | 正向/反向 WebSocket、令牌鉴权、get_status 心跳、断线重连、慢速自愈与连接诊断 |
| 入站 | 私聊/群聊、CQ 与段数组解析、@ 和回复机器人唤醒、图片/表情包/文件/语音、引用图片与合并转发展开 |
| 出站 | 纯文本、长文字图片卡片、合并转发、图片/语音/视频/文件、原生引用回复、ACP 元数据清洗 |
| 交互 | 戳一戳（默认关闭）、排队/插话、正在输入提示、中间消息、自动撤回与小结卡 |
| 会话 | 每个 QQ 聊天一个 Agent，持久化与重启恢复、/new 建立新会话、闲置回收与冲突恢复 |
| 权限 | 私聊/群聊白名单、管理员与成员工具权限、消息去重与频控、主动发送限额与审计、媒体路径/下载边界 |
| 运维 | 错误提示、长任务超时补发、链路追踪、/doctor 诊断与脱敏包、Web 设置面板、临时媒体清理 |

收到语音后可使用本地 FFmpeg/Whisper 转写；SILK 解码由 silk-wasm 提供。文字图和入站图片压缩使用 canvas；文字图还使用 fontkit 与系统字体。

## 0.9.19-kirito.3 的职责精简

本版删除以下能力及其专用状态、模块和设置入口：

- 目标记录 /goal。
- 宿主计划/权限/工作区命令 /plan、/permission、/workspace。
- QQ 中的模型/预设切换 /model、/preset，以及历史切换 /session。
- QQ 专用 ask_user_question 工具、选项回答/等待处理和计划书转发。
- 入站原始消息录制、文件事件注入、干跑拦截与离线回放。
- 独立 /ocr 命令及最近图片状态。

既有会话的磁盘日志和重启恢复继续保留，/new 会退休旧 ID，避免覆盖旧日志。旧映射中的 goal、workspacePath 等已删除状态不再恢复或写回；旧 switchable-sessions.json 不再使用。模型选择记录仍由宿主会话负责，已记录的预设按会话恢复。

旧调试配置 recordInbound、inboxRedact、injectEnabled、injectDryRun、injectIntervalMs 不再有执行路径，也不能通过设置接口写入。升级时可从配置中清理这些旧键。诊断仍包含 trace、操作审计、配置摘要与报告，不打包旧原始消息录制文件。

移除的是独立 OCR 命令：Gemini 等模型的原生看图继续可用；保留的 qq_napcat_api 仍遵循其 API 白名单。

## QQ 命令

除 /help 提供普通成员视图外，命令仅管理员可用。

| 命令 | 用途 |
| --- | --- |
| /new | 开新会话，旧日志保留 |
| /stop | 停止生成并清理待处理角色与本聊天的超时跟踪 |
| /steer 内容 | 向正在运行的任务追加补充指令 |
| /status | 查看当前会话、模型、配置预设、工作目录和运行状态 |
| /doctor [export [参考号]\|test] | 诊断、导出脱敏包或测试发送；/healthcheck 为别名 |
| /retry | 重试上一条用户消息 |
| /id、/ver | 查看会话标识、插件版本 |
| /silent [分钟] | 临时静音，再发无参数 /silent 提前解除 |
| /mode [interim\|instant] | 切换当前聊天的出站模式 |
| /help | 列出可用命令 |

未知命令默认拦截并提示；unknownCommand: passthrough 时按普通文本交给模型。普通数字、“答:”和“跳过”不再被选择或提问状态截获。

## 配置

沿用宿主 profile 的插件覆盖项；端口、令牌与凭据保留在部署配置中。常用键：

| 键 | 默认值 / 用途 |
| --- | --- |
| mode / host / port / url | reverse / 127.0.0.1 / 8643 / ws://127.0.0.1:3001 |
| accessToken | reverse 必填；forward 用于出站握手鉴权 |
| botQQ | 留空时从协议事件学习自身身份 |
| adminUsers | 管理员 QQ 列表，也可通过 ONEBOT_ALLOWED_USERS 提供 |
| dmPolicy / groupPolicy | 私聊默认仅管理员，群聊默认 open；可选 allowlist/disabled |
| allowFrom / groupAllowFrom | 私聊用户与群聊白名单 |
| requireMention | true；群聊需明确 @ 或回复机器人自己的消息 |
| pokeEnabled | false；开启后只响应明确戳向已知机器人的事件，同一会话同一发起者 3 秒节流 |
| agentPreset / agentPresetGroup | 私聊与群聊的配置预设；群聊项为空时沿用基础预设 |
| workspacePath | 默认工作区；留空使用宿主进程工作目录 |
| maxQuoteDepth | 1；整数 0–5，0 关闭引用展开，循环引用停止 |
| newMessagePolicy / autoSteerPolicy | queue / admin |
| interimMessages / interimRecall | true / true；可关闭过程消息或自动撤回 |
| textImageThreshold | 150；超过阈值转文字图，<=0 禁用文字图 |
| sttEnabled | true；需要已安装并配置相应语音转写引擎 |
| traceEnabled / actionAuditEnabled | false / true |

完整配置见 [src/index.ts](src/index.ts)。设置面板保留连接、权限、行为与诊断四组共 25 个字段；高级项可在配置文件中设置。保存配置会重载插件，可能中断在途回合并短暂重连。

原生看图需要宿主预设提供图像工具；插件将图片解析为本地路径，不会自动为模型开放通用文件或终端权限。引用图片深度、CQ/表情包解析、媒体下载和路径边界继续有效。

## 模型工具

保留 qq_send_image、qq_send_voice、qq_send_video、qq_send_file、qq_send_forward、qq_send_segments、qq_napcat_api 和 qq_group_history。成员回合默认禁用这些工具，permissions.memberTools: all 可显式放开。

模型可在回复开头写 [[reply:<mid>]] 引用入站边界中的消息 ID，负数 ID 也支持；正文中提及该语法不会被当作引用指令。文字图和断线补发保留引用目标。

## 构建与验证

使用与宿主匹配的 Node 和 @deepseek-ai 依赖。本次以 dsh 0.2.2-rc.1 / Node 24.22.2 验证。发布同名 npm 包属于上游，安装此 fork 时应使用对应版本的本地安装包或源码。

    npm install
    DSH_ROOT=<宿主 node_modules 根> ./scripts/build.sh
    npx tsc --noEmit
    npx vitest run
    npm pack

首次安装开发依赖后再执行 build；已有宿主链接时不要随意重装 node_modules。build.sh 会重建 src/ 的 JS/声明、从 client/index.js 生成设置面板，并清理已删除模块的旧构建产物。不要手改 lib/。

保留的独立验证脚本为 verify:injected-context（验证宿主持久化的消息来源，并非已删除的文件事件注入）和 verify:lan-management（网络管理入口验证）。

# QQ 昵称优先真实个人资料

## Goal and acceptance

用户指出真实 QQ 昵称应为 gemini。独立直连网关、绕过插件缓存核查：get_login_info 对用户 1162955951 返回 nickname=qbot；get_stranger_info(no_cache=true) 返回 gemini；get_group_member_info 同样返回 nickname=gemini、card=''。因此并非插件 6 小时缓存制造旧值，而是登录接口的昵称与真实资料不一致。

修正机器人三项身份的 QQ 昵称来源：优先机器人自身个人资料，失败时用群成员资料的 nickname，再用登录昵称兜底；群名片保持单独优先级，名字配置、6 小时缓存、主动回复与模型判断规则不变。不针对 qbot/gemini 写硬编码，不查询其他成员资料。

验收：登录昵称与个人资料不一致时取真实资料，群名片与 QQ 昵称独立；个人资料失败时从机器人自身群资料回退；并发查询和 6 小时缓存仍有效；三项保持进入决策与回复上下文。旧版回归应在错误 QQ 昵称上失败，部署后独立读取实际 QQ 三项并验证。

## Approach / Progress

最小修改 BotIdentity，查询个人资料与群资料可并行，沿用既有 read 缓存/超时。不改网关镜像或 transport。更新外部 API 测试替身及身份回归用例，统一构建、类型、全量测试和打包；新包 `.9`，备份 `.8` 后保持配置原文部署。

## Validation

待执行：构建、tsc、全量 vitest、旧源码回归、安装包字节核对/补丁恢复、真实 QQ 身份读取、服务与 QQ 在线。无人工 QQ 测试消息。

## Result

`.9` 优先自身 get_stranger_info 昵称，失败回退群资料 nickname、登录昵称，群名片独立；只查询自身资料，继续 6 小时缓存，个人资料和群资料并行。没有对 qbot/gemini 做字符串特判，未改网关镜像、判断规则或主动回复开关。

构建/类型/差异/包内字节/补丁恢复通过；全量 50 文件、864 项通过、5 跳过，身份 10 项通过。新增个人资料优先回归在旧 `.8` 源码上因 qbot/gemini 不匹配按预期失败。

01:12 升级，01:13:53 服务/QQ 在线、HTTP 鉴权、原配置字节对照通过。实际安装模块读到登录接口 qbot、真实个人/群资料 gemini，最终身份 qq=1162955951、qqNickname=gemini、groupNickname=gemini，校验通过。主动回复与 6 小时缓存保持，无付费模型调用，无 QQ 测试消息。证据及回滚脚本在 `hosts/5o1/services/qq-assistant/changes/2026-11-14-real-qq-nickname/`。复用用户会话并保留连接，源码未提交/推送；任务完成，移入 completed。

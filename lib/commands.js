import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapUserMessage } from './chat.js';
import { describeError } from './errors.js';
import { failureRefSuffix, isFailureRef } from './ref.js';
import { resolveNoticeText } from './notices.js';
/** The routed command table. Row order = the /help line order inside each
 * group (the router matches by name, so ordering is routing-neutral). */
export const COMMANDS = [
    { name: 'new', adminOnly: true, group: '会话', help: '开启新会话（清空上下文）', handler: async (ctx, chatId) => {
            ctx.log('info', 'slash /new for ' + chatId);
            await ctx.resetChat(chatId);
        } },
    { name: 'stop', adminOnly: true, group: '操作', help: '停止当前生成', handler: (ctx, chatId) => handleStopCommand(ctx, chatId) },
    { name: 'steer', adminOnly: true, group: '操作', help: '<补充内容> 向运行中的任务补充指令', handler: (ctx, chatId, arg, sender) => handleSteerCommand(ctx, chatId, arg, sender) },
    { name: 'status', adminOnly: true, group: '查询', help: '会话全景', handler: (ctx, chatId) => handleStatusCommand(ctx, chatId) },
    { name: 'doctor', aliases: ['healthcheck'], adminOnly: true, group: '查询', help: '[export [参考号]|test] 运行体检（export [参考号] 导出脱敏诊断包；test 一键自测收发链路）', handler: (ctx, chatId, arg) => handleHealthcheckCommand(ctx, chatId, arg) },
    { name: 'retry', adminOnly: true, group: '操作', help: '重跑上一条', handler: (ctx, chatId) => handleRetryCommand(ctx, chatId) },
    { name: 'id', adminOnly: true, group: '查询', help: '会话标识（session/chat）', handler: (ctx, chatId) => handleIdCommand(ctx, chatId) },
    { name: 'ver', adminOnly: true, group: '查询', help: '插件版本', handler: (ctx, chatId) => handleVerCommand(ctx, chatId) },
    { name: 'silent', adminOnly: true, group: '操作', help: '[分钟] 临时免打扰（默认 30 分钟，期间普通消息被忽略；再次 /silent 提前解除）', handler: (ctx, chatId, arg) => handleSilentCommand(ctx, chatId, arg) },
    { name: 'mode', adminOnly: true, group: '输出', help: '[interim|instant] 出站模式（合并卡片/逐条即时）', handler: (ctx, chatId, arg) => handleModeCommand(ctx, chatId, arg) },
    { name: 'help', adminOnly: true, memberVisible: true, group: '其他', help: '本帮助', handler: async (ctx, chatId, _arg, sender) => {
            // T3-board: members get the member view (memberVisible rows only); the
            // admin card is unchanged.
            await ctx.sendToChat(chatId, ctx.isAdmin(sender.userId) ? helpText() : helpText(true));
        } },
];
/** /help group headers in card order; a row whose group is not listed here
 * renders under an appended header (first-seen table order), so a new
 * command row always shows up in the card. */
const HELP_GROUP_ORDER = ['会话', '输出', '查询', '操作', '其他'];
/** /help body: grouped multi-line card generated from the table — adding a
 * command stays a one-row change and its group header comes from the row
 * (unlisted groups append). The R1 tail line documents the unknown-command
 * behavior. Exported for the full-text snapshot gate in tests/commands.spec.ts.
 * T3-board: memberOnly=true renders the member view — only memberVisible
 * rows, a neutral header, and a 「其余命令需管理员」 tail. */
export function helpText(memberOnly = false) {
    const groups = new Map();
    for (const c of COMMANDS) {
        if (memberOnly && c.memberVisible !== true)
            continue;
        const key = c.group ?? '其他';
        const rows = groups.get(key);
        if (rows === undefined)
            groups.set(key, [c]);
        else
            rows.push(c);
    }
    const order = [...groups.keys()].sort((a, b) => {
        const ia = HELP_GROUP_ORDER.indexOf(a);
        const ib = HELP_GROUP_ORDER.indexOf(b);
        return (ia === -1 ? HELP_GROUP_ORDER.length : ia) - (ib === -1 ? HELP_GROUP_ORDER.length : ib);
    });
    const lines = [memberOnly ? '可用命令：' : '可用命令（仅管理员）：'];
    for (const g of order) {
        lines.push('▍' + g);
        for (const c of groups.get(g))
            lines.push('/' + c.name + ' ' + c.help);
    }
    const tail = memberOnly
        ? '其余命令需管理员。\n未知命令默认拦截并提示相近命令；unknownCommand: passthrough 可改为透传给模型。'
        : '未知命令默认拦截并提示相近命令；unknownCommand: passthrough 可改为透传给模型。';
    return lines.join('\n') + '\n\n' + tail;
}
/** Close command-name suggestions for an unknown /word: prefix matches first
 * (table order), then an edit-distance ≤2 fallback that only runs for inputs
 * of length ≥4 (so short real commands like /id or /ver are never shadowed);
 * an alias candidate suggests its primary name. At most 3 candidates are
 * listed. */
function suggestCommands(input) {
    const canonical = new Map();
    for (const c of COMMANDS) {
        canonical.set(c.name, c.name);
        for (const a of c.aliases ?? [])
            canonical.set(a, c.name);
    }
    const names = [...canonical.keys()];
    const suggestions = names.filter(n => n.startsWith(input)).map(n => canonical.get(n));
    if (suggestions.length === 0 && input.length >= 4) {
        suggestions.push(...names.filter(n => Math.abs(n.length - input.length) <= 2 && editDistanceWithin2(input, n)).map(n => canonical.get(n)));
    }
    return suggestions.slice(0, 3);
}
/** Whether the Levenshtein distance between a and b is ≤2 (single words only). */
function editDistanceWithin2(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length] <= 2;
}
/**
 * Slash-command router. Commands are admin-only (the Hermes member
 * slash-command block) and are matched on the first word; a leading
 * @mention glued to the command (QQ group at + text) is stripped first.
 * A path like /tmp/x is never a command (command words are
 * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands get closest-match
 * suggestions (prefix first, edit distance ≤2 for length ≥4 inputs only)
 * and are consumed; with no suggestion, config.unknownCommand decides —
 * 'intercept' (default) consumes with a hint, 'passthrough' returns false
 * so the message reaches the model (the old Hermes fall-through).
 * @param ctx - bridge capabilities (built by ChatBridge).
 * @param chatId - the chat the command arrived in.
 * @param text - parsed inbound text.
 * @param userId - sender QQ number.
 * @param nickname - sender display name (pre-sanitized by inbound.ts); used
 *   by /steer for the <user_message> boundary attribute (T9-A).
 * @returns true when the message was consumed by a command.
 */
export async function tryHandleCommand(ctx, chatId, text, userId, nickname) {
    const normalized = text.replace(/^@\d+\s*/, '');
    const first = (normalized.split(/\s+/, 1)[0] ?? '').trim();
    if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(first))
        return false;
    if (!ctx.isAdmin(userId)) {
        // T3-board: member-visible commands run for non-admins; everything else
        // (including unknown commands) keeps the admin-only notice. Only rows
        // flagged memberVisible carve this exception — the gate stays the default.
        const name = first.slice(1).toLowerCase();
        const memberCommand = COMMANDS.find(c => c.name === name || c.aliases?.includes(name));
        if (memberCommand !== undefined && memberCommand.memberVisible === true) {
            ctx.log('debug', 'slash /' + name + ' (member) for ' + chatId);
            await memberCommand.handler(ctx, chatId, normalized.slice(first.length).trim(), { userId, nickname: nickname ?? '' });
            return true;
        }
        await ctx.sendToChat(chatId, '该命令仅管理员可用。');
        return true;
    }
    const name = first.slice(1).toLowerCase();
    ctx.log('debug', 'slash /' + name + ' for ' + chatId);
    const command = COMMANDS.find(c => c.name === name || c.aliases?.includes(name));
    if (command === undefined) {
        const suggestions = suggestCommands(name);
        if (suggestions.length > 0) {
            const names = suggestions.map(s => '/' + s);
            const label = names.length === 1 ? names[0] : names[0] + '（' + names.slice(1).join('、') + '）';
            await ctx.sendToChat(chatId, '未知命令 /' + name + '，你是想用 ' + label + '吗？');
            return true;
        }
        if ((ctx.config.unknownCommand ?? 'intercept') !== 'passthrough') {
            await ctx.sendToChat(chatId, '未知命令 /' + name + '。发 /help 查看命令列表；要让模型处理请去掉开头的 / 重发。');
            return true;
        }
        return false;
    }
    await command.handler(ctx, chatId, normalized.slice(first.length).trim(), { userId, nickname: nickname ?? '' });
    return true;
}
/** /stop: cancel the running generation and drop deferred loop state. */
async function handleStopCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    // Clear before awaiting the acknowledgement, even if sending it fails.
    if (chat !== undefined)
        chat.pendingTurnRoles.length = 0;
    if (chat !== undefined && chat.pendingTurnProactive !== undefined)
        chat.pendingTurnProactive.length = 0;
    if (chat !== undefined && chat.agent.status === 'running') {
        chat.agent.cancel({ kind: 'user' });
        // Drop the deferred loop state so the cancelled turn settles silently
        // instead of flushing its partial text as a final.
        chat.loopPending = null;
        chat.loopBuffer = [];
        await ctx.sendToChat(chatId, '⏹ 已停止生成。');
    }
    else {
        await ctx.sendToChat(chatId, '当前没有正在进行的生成。');
    }
    // T3 (P2): 无论是否有运行中生成，都显式终止该聊天的超时补发跟踪——
    // /stop 的语义边界是「只终止当前聊天提交的回合」，补发跟踪随行终止；
    // 其他聊天的条目不受影响。
    ctx.stopDeferredTracking(chatId);
}
/** T3-board /silent defaults and bounds: a bare /silent mutes for 30 minutes;
 * the explicit form accepts 1–1440 minutes (one day) — beyond that a real
 * schedule is the right surface, not a chat command. */
export const SILENT_DEFAULT_MINUTES = 30;
export const SILENT_MAX_MINUTES = 24 * 60;
/** T3-board /silent: per-chat temporary do-not-disturb. While the window is
 * open the inbound pipeline silently ignores NORMAL messages (slash commands
 * still route — the probe sits after the command router, so /silent itself
 * can never be swallowed by its own mute). A bare /silent lifts the window
 * early; `/silent <分钟>` sets/extends it. The window survives /new (a
 * property of the chat, not the session) and plugin restarts (persisted in
 * chat-sessions.json via ChatSettings.silentUntil). */
async function handleSilentCommand(ctx, chatId, arg) {
    if (ctx.silentUntil === undefined || ctx.setSilentUntil === undefined) {
        await ctx.sendToChat(chatId, '⚠️ 静音窗口未接线（宿主未提供该能力）。');
        return;
    }
    // numbers in full-width or ASCII brackets.
    const trimmed = arg.trim().replace(/^[<＜([{（【]+\s*/, '').replace(/\s*[>＞)}）】\]]+$/, '').trim();
    if (trimmed === '') {
        if ((ctx.silentUntil(chatId) ?? 0) > Date.now()) {
            ctx.setSilentUntil(chatId, undefined);
            ctx.log('info', 'slash /silent lifted early for ' + chatId);
            await ctx.sendToChat(chatId, '🔔 已解除静音，恢复正常响应。');
            return;
        }
        ctx.setSilentUntil(chatId, Date.now() + SILENT_DEFAULT_MINUTES * 60_000);
        ctx.log('info', 'slash /silent (default ' + SILENT_DEFAULT_MINUTES + 'm) for ' + chatId);
        await ctx.sendToChat(chatId, `🔇 已静音 ${SILENT_DEFAULT_MINUTES} 分钟（至 ${formatTimestamp(Date.now() + SILENT_DEFAULT_MINUTES * 60_000)}）：期间普通消息将被忽略，斜杠命令不受影响。再次 /silent 可提前解除。`);
        return;
    }
    const minutes = Number(trimmed);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SILENT_MAX_MINUTES) {
        await ctx.sendToChat(chatId, `❌ 分钟数无效：${trimmed}（有效范围 1–${SILENT_MAX_MINUTES}）。\n用法：/silent [分钟] 临时免打扰（默认 ${SILENT_DEFAULT_MINUTES} 分钟）；/silent 提前解除。`);
        return;
    }
    const until = Date.now() + minutes * 60_000;
    ctx.setSilentUntil(chatId, until);
    ctx.log('info', 'slash /silent (' + minutes + 'm) for ' + chatId);
    await ctx.sendToChat(chatId, `🔇 已静音 ${minutes} 分钟（至 ${formatTimestamp(until)}）：期间普通消息将被忽略，斜杠命令不受影响。再次 /silent 可提前解除。`);
}
/** T2 (P1): the /steer submit notice — one line per accepted instruction.
 * Shared with the bridge's auto-steer path ('steer' policy) so both surfaces
 * word the confirmation identically; exported for the deterministic text
 * wait in tests. */
export const STEER_ACCEPTED_NOTICE = '✅ 已作为补充指令提交给当前任务，模型将在下一步读取。';
/** T2 (P1): the /steer usage hint — replied whenever the command cannot
 * steer (empty argument, no live chat, or no running task). Never crashes,
 * never silently no-ops. */
export const STEER_USAGE_HINT = '用法：/steer <补充内容> —— 在任务运行期间向当前任务追加一条补充指令，模型会在下一步读取；当前没有运行中的任务，直接发送消息即可开始新任务。';
/** T2 (P1) /steer: steer one supplementary instruction into the RUNNING
 * turn (both newMessagePolicy modes — an explicit /steer is always allowed).
 * Without a running task (or with an empty argument, or no live chat) it
 * replies with the usage hint instead of steering — the idle-driver steer
 * would otherwise open a turn, which is what plain messages already do.
 * T9-A: the argument enters the prompt wrapped in the same <user_message>
 * boundary as every inbound payload (same wrapUserMessage shape, qq +
 * nickname attributes) — /steer is admin-gated (trusted sender) but the
 * boundary posture must not fork between the two steerMessage callers. */
async function handleSteerCommand(ctx, chatId, arg, sender) {
    const raw = arg.trim();
    const text = raw === '' ? '' : wrapUserMessage(raw, sender.userId, sender.nickname);
    const chat = ctx.getChat(chatId);
    if (text === '' || chat === undefined || chat.agent.status !== 'running' || !ctx.steerRunningTurn(chatId, text)) {
        ctx.log('debug', 'slash /steer rejected (no running task or empty argument) for ' + chatId);
        await ctx.sendToChat(chatId, STEER_USAGE_HINT);
        return;
    }
    ctx.log('info', 'slash /steer for ' + chatId);
    // T1 (#27): the command confirmation is a command reply, not an auto
    // receipt — `false` keeps the default text; only a non-empty custom
    // string replaces it (resolveNoticeText maps '' → null = 不发).
    const notice = ctx.notices?.steerAccepted === false
        ? STEER_ACCEPTED_NOTICE
        : resolveNoticeText(ctx.notices?.steerAccepted, STEER_ACCEPTED_NOTICE);
    if (notice !== null)
        await ctx.sendToChat(chatId, notice);
}
/** /id: show the chat/session identity (admin debug aid). */
async function handleIdCommand(ctx, chatId) {
    const sessionId = ctx.getChat(chatId)?.sessionId ?? await ctx.sessionIdFromMapping(chatId);
    await ctx.sendToChat(chatId, 'chat    : ' + chatId + '\n' +
        'session : ' + (sessionId ?? '（未建立会话，下一条消息创建）') + '\n' +
        'cwd     : ' + ctx.effectiveCwd(chatId));
}
/** /ver: plugin version + git commit (each read once and cached). */
async function handleVerCommand(ctx, chatId) {
    const commit = gitCommit();
    await ctx.sendToChat(chatId, 'dsh-onebot v' + (packageVersion() ?? '?') + (commit !== undefined ? ' (' + commit + ')' : ''));
}
async function handleStatusCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    const sessionId = chat?.sessionId ?? await ctx.sessionIdFromMapping(chatId);
    const preset = await ctx.resolvePresetId(chatId);
    const current = safeChatModel(chat, ctx) ?? safeDefaultModel(ctx);
    const model = current !== undefined ? current.provider + '/' + current.model : '（未设置）';
    const interim = ctx.interimOverride(chatId);
    await ctx.sendToChat(chatId, 'chat    : ' + chatId + '\n' +
        'session : ' + (sessionId ?? '（未建立会话）') + '\n' +
        'preset  : ' + (preset ?? '（未记录）') + '\n' +
        'model   : ' + model + '\n' +
        'cwd     : ' + ctx.effectiveCwd(chatId) + '\n' +
        '出站     : ' + ((interim ?? ctx.config.interimMessages) ? 'interim' : 'instant') + '\n' +
        'agent   : ' + (chat !== undefined ? 'busy=' + chat.busy + ' loopBuffer=' + chat.loopBuffer.length : '（未建立会话）'));
}
/** W1/T5 /healthcheck: render the health summary, or pack the redacted
 * diagnostics archive with the `export` argument. Failures are reported to
 * the chat as a ⚠️ line, never thrown past the router. */
async function handleHealthcheckCommand(ctx, chatId, arg) {
    const trimmed = arg.trim();
    // T4 (P3): `export [参考号]` — an explicit reference is validated against
    // the reference format before it reaches the archive file name (fail-closed:
    // junk input gets the usage line, never a sanitized-weird file name).
    const exportMatch = /^export(\s+(\S+))?$/.exec(trimmed);
    if (exportMatch !== null) {
        const triggerRef = exportMatch[2];
        if (triggerRef !== undefined && !isFailureRef(triggerRef)) {
            await ctx.sendToChat(chatId, '⚠️ 参考号格式不正确：' + triggerRef + '\n用法：/doctor（体检摘要）或 /doctor export [参考号]（导出脱敏诊断包；参考号形如 MF-xxx / QQ-CONN-xxx，省略时自动使用最近一次故障的参考号）。');
            return;
        }
        if (ctx.exportDiagnostics === undefined) {
            await ctx.sendToChat(chatId, '⚠️ 诊断包导出未启用（health 模块未接线）。');
            return;
        }
        try {
            const archive = await ctx.exportDiagnostics(triggerRef);
            await ctx.sendToChat(chatId, '📦 诊断包已导出（token/accessToken 已强制脱敏）：\n' + archive);
        }
        catch (error) {
            await ctx.sendToChat(chatId, '⚠️ 诊断包导出失败：' + describeError(error));
        }
        return;
    }
    // T3-board: `test` — one-shot end-to-end self-test (see runDoctorTest).
    if (trimmed === 'test') {
        await runDoctorTest(ctx, chatId);
        return;
    }
    if (trimmed !== '') {
        await ctx.sendToChat(chatId, '用法：/doctor（体检摘要）或 /doctor export [参考号]（导出脱敏诊断包）。');
        return;
    }
    if (ctx.healthReport === undefined) {
        await ctx.sendToChat(chatId, '⚠️ 体检未启用（health 模块未接线）。');
        return;
    }
    try {
        await ctx.sendToChat(chatId, await ctx.healthReport());
    }
    catch (error) {
        await ctx.sendToChat(chatId, '⚠️ 体检失败：' + describeError(error));
    }
}
/** T3-board /doctor test: one-shot end-to-end self-test — push a marker
 * message through the FULL outbound pipeline (ctx.sendToChat, not a raw
 * connection call, so queueing/card-relay behave exactly like production)
 * and report connection state, delivery outcome and round-trip latency.
 * A send failure is reported describeError-style with an MF- reference tail
 * (same posture as /retry) and never thrown past the router. The marker
 * message is visible in the chat by design: the user receiving it IS the
 * success signal. */
async function runDoctorTest(ctx, chatId) {
    const connected = ctx.connection.connected;
    const started = Date.now();
    try {
        await ctx.sendToChat(chatId, '🧪 /doctor test 自测消息：收到本条即代表出站链路正常，请忽略。');
    }
    catch (error) {
        const ref = ctx.reportFailure?.(chatId, 'command', '/doctor test 发送失败: ' + describeError(error));
        ctx.log('warn', 'slash /doctor test failed for ' + chatId + ': ' + describeError(error));
        await ctx.sendToChat(chatId, '⚠️ /doctor test 自测失败\n连接：' + (connected ? '已连接' : '未连接') + '\n发送：失败 — ' + describeError(error) + failureRefSuffix(ref));
        return;
    }
    const ms = Date.now() - started;
    ctx.log('info', 'slash /doctor test ok for ' + chatId + ' (' + ms + ' ms, connected=' + connected + ')');
    await ctx.sendToChat(chatId, '✅ /doctor test 自测通过\n连接：' + (connected ? '已连接' : '未连接') + '\n发送：成功\n时延：' + ms + ' ms');
}
/** /mode: per-chat outbound-mode override (interim vs instant). */
async function handleModeCommand(ctx, chatId, arg) {
    const v = arg.trim().toLowerCase();
    if (v === '' || v === 'status' || v === 'view') {
        const interim = ctx.interimOverride(chatId);
        const eff = interim ?? ctx.config.interimMessages;
        const suffix = interim !== undefined ? '（/mode 覆盖）' : '（全局配置）';
        await ctx.sendToChat(chatId, `当前出站模式：${eff ? 'interim（合并卡片）' : 'instant（逐条即时）'}${suffix}\n用法：/mode interim|instant 切换；/mode 查看`);
        return;
    }
    if (v === 'interim' || v === 'on' || v === 'merge') {
        ctx.setInterimOverride(chatId, true);
        await ctx.sendToChat(chatId, '✅ 出站模式已切换为 interim（合并卡片）。下一条回复生效。');
        return;
    }
    if (v === 'instant' || v === 'off' || v === 'direct') {
        ctx.setInterimOverride(chatId, false);
        await ctx.sendToChat(chatId, '✅ 出站模式已切换为 instant（逐条即时）。下一条回复生效。');
        return;
    }
    const eff = ctx.interimOverride(chatId) ?? ctx.config.interimMessages;
    await ctx.sendToChat(chatId, `❌ 无法识别的出站模式：${arg.trim()}\n当前生效：${eff ? 'interim（合并卡片）' : 'instant（逐条即时）'}\n用法：/mode interim|instant 切换；/mode 查看当前`);
}
/** /retry: re-feed the last user message into the agent. */
async function handleRetryCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    if (chat === undefined) {
        await ctx.sendToChat(chatId, '没有可重试的上一条消息。\n先发送一条消息，之后才能 /retry。');
        return;
    }
    if (chat.busy) {
        await ctx.sendToChat(chatId, '当前正在生成，请稍后再重试。');
        return;
    }
    const text = chat.lastFollowup;
    if (text === undefined || text === '') {
        await ctx.sendToChat(chatId, '没有可重试的上一条消息。\n先发送一条消息，之后才能 /retry。');
        return;
    }
    // Start a fresh reply cycle exactly like a new inbound turn.
    chat.loopBuffer = [];
    chat.loopPending = null;
    ctx.log('info', 'retry for ' + chatId);
    // /retry is admin-gated in tryHandleCommand, so the retried turn's role is
    // the admin who issued the command (M1-A2).
    try {
        await ctx.dispatchFollowup(chatId, text, 'admin', chat.lastNickname);
    }
    catch (error) {
        // T4 (P3): a failed retry is a message fault — mint an MF- reference
        // (trace + structured log via the bridge) and surface it in the ⚠️ notice
        // instead of letting the throw escape the router silently.
        const ref = ctx.reportFailure?.(chatId, 'command', '/retry 重试失败: ' + describeError(error));
        await ctx.sendToChat(chatId, '⚠️ 重试失败：' + describeError(error) + failureRefSuffix(ref));
    }
}
/** Render an epoch-ms timestamp as YYYY-MM-DD HH:mm (local time) — the
 * /session list's retire and creation times share the format. */
function formatTimestamp(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/** Current default model selection, best-effort (absent services return undefined). */
function safeDefaultModel(ctx) {
    try {
        return ctx.agentDefaultModel?.currentSelection();
    }
    catch (error) {
        ctx.log('debug', 'currentSelection failed: ' + String(error));
        return undefined;
    }
}
/** #17: chat.model.current() can throw (model registry in a bad state); the
 * /model and /status surfaces must degrade to the deployment default instead
 * of crashing the command handler (same pattern as safeDefaultModel). */
function safeChatModel(chat, ctx) {
    try {
        return chat?.agent.model.current();
    }
    catch (error) {
        ctx.log('debug', 'model.current failed: ' + String(error));
        return undefined;
    }
}
/** Plugin version from package.json, read once (per process). Exported for the /ver ESM regression test. */
let cachedPluginVersion;
export function packageVersion() {
    if (cachedPluginVersion === undefined) {
        try {
            const pkg = JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8'));
            cachedPluginVersion = typeof pkg.version === 'string' ? pkg.version : undefined;
        }
        catch {
            cachedPluginVersion = undefined;
        }
    }
    return cachedPluginVersion;
}
/** Git short commit of the plugin repo, read once (best-effort, per process). */
let cachedGitCommit;
function gitCommit() {
    if (cachedGitCommit === undefined) {
        try {
            const root = dirname(dirname(fileURLToPath(import.meta.url)));
            const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
            cachedGitCommit = commit !== '' ? commit : undefined;
        }
        catch {
            cachedGitCommit = undefined;
        }
    }
    return cachedGitCommit;
}

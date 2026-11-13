/**
 * Slash-command surface (M2-D1-PR1): the routed command table, the narrow
 * CommandContext through which handlers touch the bridge, and the router.
 * Extracted verbatim from bridge.ts — reply texts, argument parsing and
 * error behavior are byte-identical to the pre-split if-chain; /help is now
 * generated from the table (snapshot-gated in tests/commands.spec.ts).
 * @module dsh-onebot/commands
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { OneBotConnection } from './connection.js';
import { type ChatId, type UserRole } from './chat.js';
import type { AgentDefaultModelLike, BridgeConfig } from './bridge.js';
import type { TraceStage } from './trace.js';
import { type NoticeSetting } from './notices.js';
/** Narrow view of a live chat the command handlers may read or mutate —
 * the structural subset of the bridge's internal ChatAgent that the
 * pre-split handlers actually touched. */
export interface CommandChatView {
    agent: Agent;
    sessionId: SessionId;
    busy: boolean;
    lastFollowup: string | undefined;
    lastNickname: string;
    loopPending: string | null;
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    pendingTurnRoles: UserRole[];
}
export interface CommandContext {
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    notices?: {
        steerAccepted?: NoticeSetting;
    };
    isAdmin(userId: string): boolean;
    getChat(chatId: ChatId): CommandChatView | undefined;
    hasChat(chatId: ChatId): boolean;
    resetChat(chatId: ChatId): Promise<void>;
    dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void>;
    stopDeferredTracking(chatId: ChatId): void;
    steerRunningTurn(chatId: ChatId, text: string): boolean;
    effectiveCwd(chatId: ChatId): string;
    sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>;
    resolvePresetId(chatId: ChatId): Promise<string | undefined>;
    interimOverride(chatId: ChatId): boolean | undefined;
    setInterimOverride(chatId: ChatId, value: boolean): void;
    agentDefaultModel: AgentDefaultModelLike | undefined;
    connection: OneBotConnection;
    healthReport?: (() => Promise<string>) | undefined;
    exportDiagnostics?: ((triggerRef?: string) => Promise<string>) | undefined;
    reportFailure?: ((chatId: ChatId, stage: TraceStage, detail: string) => string) | undefined;
    silentUntil?: ((chatId: ChatId) => number | undefined) | undefined;
    setSilentUntil?: ((chatId: ChatId, untilMs: number | undefined) => void) | undefined;
    config: Pick<BridgeConfig, 'interimMessages' | 'unknownCommand'>;
}
/** T9-A: the sender identity the inbound pipeline already resolved for the
 * command message — threaded through tryHandleCommand so /steer can wrap its
 * argument in the same <user_message> boundary as every inbound payload
 * (M3-D5 invariant: all user content enters the prompt behind the boundary).
 * The nickname is the pre-sanitized value from inbound.ts; wrapUserMessage
 * re-sanitizes defensively. */
export interface CommandSender {
    userId: string;
    nickname: string;
}
/** One routed slash command: the table row IS the registration (D1-PR1) —
 * adding a command is exactly one row here and /help picks it up for free. */
export interface CommandDefinition {
    /** Command word after the leading slash (matched case-insensitively). */
    name: string;
    /** Alternative first-words routed to the same handler; rendered nowhere
     * (/help lists only `name`, suggestions map an alias back to it). */
    aliases?: string[];
    /** Admin-only flag; every current command is gated at the router entry. */
    adminOnly: boolean;
    /** T3-board: member-visible command — a non-admin (group member) may
     * invoke it; /help's member view lists ONLY these rows. The admin gate
     * stays the default; this flag carves per-row exceptions. */
    memberVisible?: boolean;
    /** /help line shown after "/name ": the usage-argument form (when the
     * command takes arguments) followed by the description, e.g.
     * "[路径|序号|list] 查看或切换工作区" or plain "本帮助". */
    help: string;
    /** /help group header the row renders under (no ▍ prefix). Rows without
     * one fall into 「其他」; a group outside the fixed card order still renders
     * (appended), so a new row always shows up in the card. */
    group?: string;
    handler(ctx: CommandContext, chatId: ChatId, arg: string, sender: CommandSender): Promise<void>;
}
/** The routed command table. Row order = the /help line order inside each
 * group (the router matches by name, so ordering is routing-neutral). */
export declare const COMMANDS: CommandDefinition[];
/** /help body: grouped multi-line card generated from the table — adding a
 * command stays a one-row change and its group header comes from the row
 * (unlisted groups append). The R1 tail line documents the unknown-command
 * behavior. Exported for the full-text snapshot gate in tests/commands.spec.ts.
 * T3-board: memberOnly=true renders the member view — only memberVisible
 * rows, a neutral header, and a 「其余命令需管理员」 tail. */
export declare function helpText(memberOnly?: boolean): string;
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
export declare function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string, nickname?: string): Promise<boolean>;
/** T3-board /silent defaults and bounds: a bare /silent mutes for 30 minutes;
 * the explicit form accepts 1–1440 minutes (one day) — beyond that a real
 * schedule is the right surface, not a chat command. */
export declare const SILENT_DEFAULT_MINUTES = 30;
export declare const SILENT_MAX_MINUTES: number;
/** T2 (P1): the /steer submit notice — one line per accepted instruction.
 * Shared with the bridge's auto-steer path ('steer' policy) so both surfaces
 * word the confirmation identically; exported for the deterministic text
 * wait in tests. */
export declare const STEER_ACCEPTED_NOTICE = "\u2705 \u5DF2\u4F5C\u4E3A\u8865\u5145\u6307\u4EE4\u63D0\u4EA4\u7ED9\u5F53\u524D\u4EFB\u52A1\uFF0C\u6A21\u578B\u5C06\u5728\u4E0B\u4E00\u6B65\u8BFB\u53D6\u3002";
/** T2 (P1): the /steer usage hint — replied whenever the command cannot
 * steer (empty argument, no live chat, or no running task). Never crashes,
 * never silently no-ops. */
export declare const STEER_USAGE_HINT = "\u7528\u6CD5\uFF1A/steer <\u8865\u5145\u5185\u5BB9> \u2014\u2014 \u5728\u4EFB\u52A1\u8FD0\u884C\u671F\u95F4\u5411\u5F53\u524D\u4EFB\u52A1\u8FFD\u52A0\u4E00\u6761\u8865\u5145\u6307\u4EE4\uFF0C\u6A21\u578B\u4F1A\u5728\u4E0B\u4E00\u6B65\u8BFB\u53D6\uFF1B\u5F53\u524D\u6CA1\u6709\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1\uFF0C\u76F4\u63A5\u53D1\u9001\u6D88\u606F\u5373\u53EF\u5F00\u59CB\u65B0\u4EFB\u52A1\u3002";
export declare function packageVersion(): string | undefined;

import type { ChatId } from './chat.js';
import type { NormalizedInbound } from './inbound.js';
import type { DecisionConfig, ObservedMessage, ReplyDecision } from './decision.js';
import type { BotIdentity } from './identity.js';
export interface ProactiveConfig {
    enabled: boolean;
    shadow: boolean;
    groups: string[];
    ignoredUsers: string[];
    botProfile: string;
    quietMs: number;
    waitMaxMs: number;
    decisionIntervalMs: number;
    cooldownMs: number;
    hourlyLimit: number;
    dailyLimit: number;
    ttlMs: number;
    addressedThreshold: number;
    invitationThreshold: number;
    valueThreshold: number;
    silenceBoost: number;
    interruptionThreshold: number;
    decision: DecisionConfig;
}
export declare const PROACTIVE_DEFAULTS: ProactiveConfig;
export interface ProactiveTurn {
    id: string;
    chatId: ChatId;
    target: ObservedMessage;
    messages: ObservedMessage[];
    decision: ReplyDecision;
    valueThreshold: number;
    revision: number;
    createdAt: number;
    cancelled: boolean;
    started: boolean;
    text: string;
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
}
export interface ProactiveContext {
    identity?: Pick<BotIdentity, 'resolve' | 'current'>;
    config: ProactiveConfig;
    mediaDir: string;
    allowed(chatId: ChatId): boolean;
    busy(chatId: ChatId): boolean;
    dispatch(turn: ProactiveTurn, text: string): Promise<boolean>;
    cancelRunning(chatId: ChatId): void;
    /** Must check guard immediately before the wire send, after any send queue. */
    send(chatId: ChatId, text: string, guard: () => boolean): Promise<string | undefined>;
    log(level: 'info' | 'warn' | 'debug', message: string): void;
}
/** Buffer and scheduler are group-local; decision providers never own conversation memory. */
export declare class ProactiveReplies {
    private readonly ctx;
    private readonly groups;
    private readonly quotas;
    private readonly deliveries;
    private readonly ready;
    private writes;
    private stopped;
    private localId;
    private readonly localIds;
    constructor(ctx: ProactiveContext);
    private state;
    private enabled;
    /** Called only after the existing access/duplicate/self and quote-author checks. */
    observe(inbound: NormalizedInbound, direct: boolean): void;
    private append;
    recordBot(chatId: ChatId, id: string, text: string): void;
    markProvided(inbound: NormalizedInbound): void;
    recall(chatId: ChatId, id: string): void;
    /** Direct traffic, /silent, /stop, /new and disconnect invalidate speculative work. */
    cancel(chatId: ChatId, cancelRunning?: boolean): void;
    reset(chatId: ChatId): void;
    cancelAll(): void;
    stop(): Promise<void>;
    private schedule;
    private quotaAllowed;
    private continuation;
    private willingness;
    private approved;
    private input;
    private consider;
    private packet;
    private deliveryStatus;
    /** Model-visible runtime facts: generated drafts are distinct from delivered messages. */
    deliveryContext(chatId: ChatId): string;
    /** Used both before dispatch and at the final queued wire-send boundary. */
    valid(turn: ProactiveTurn): boolean;
    startTurn(chatId: ChatId): void;
    capture(chatId: ChatId, text: string, hasToolCall: boolean): void;
    /** Nothing is emitted until the turn completes and the live conversation is rechecked. */
    finish(chatId: ChatId, completed: boolean): Promise<void>;
    private loadQuotas;
    private saveQuotas;
}

/** Native decision APIs only: no chat completions or generated-JSON fallback. */
export type DecisionProvider = 'typesafe' | 'openrouter' | 'vercel' | 'systemone';
export interface DecisionConfig {
    provider: DecisionProvider;
    /** Full native decision endpoint; empty selects the provider default. */
    endpoint: string;
    model: string;
    /** Environment-variable reference, never an API key in the plugin config. */
    apiKeyEnv: string;
    timeoutMs: number;
}
export interface ObservedMessage {
    id: string;
    speaker: string;
    nickname: string;
    text: string;
    replyTo?: string;
    at: number;
    bot: boolean;
    candidate?: boolean;
}
import type { BotIdentityData } from './identity.js';
export interface DecisionInput {
    messages: readonly ObservedMessage[];
    targetId: string;
    botProfile: string;
    botIdentity?: BotIdentityData;
    continuation: boolean;
}
export interface ReplyDecision {
    addressed: number;
    invitation: number;
    value: number;
    interruption: number;
    mode: 'casual' | 'helpful' | 'empathetic' | 'none';
    relevantIds: string[];
    model: string;
    inputTokens?: number;
    outputTokens?: number;
}
/** A fresh, bounded request per evaluation. Raw QQ ids are replaced by local labels. */
export declare function evaluateReply(config: DecisionConfig, input: DecisionInput, signal?: AbortSignal): Promise<ReplyDecision>;

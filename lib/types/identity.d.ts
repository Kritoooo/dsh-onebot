import type { ChatId } from './chat.js';
export interface BotIdentityData {
    name: string;
    source: 'config' | 'group-card' | 'group-nickname' | 'qq-nickname' | 'unknown';
    qq?: string;
    qqNickname?: string;
    groupNickname?: string;
}
/** One shared identity source for both models; only fetches the bot's own QQ profile. */
export declare class BotIdentity {
    private readonly config;
    private readonly selfId;
    private readonly call;
    private readonly cache;
    constructor(config: {
        botName?: string;
    }, selfId: () => string, call: (action: string, params: Record<string, unknown>) => Promise<unknown>);
    clear(): void;
    private read;
    current(chatId: ChatId): BotIdentityData;
    resolve(chatId: ChatId): Promise<BotIdentityData>;
    context(chatId: ChatId): string;
}

/** Translate a poke notice into an inbound event, preserving QQ access gates. */
import type { OneBotEvent } from './connection.js';
export interface PokeHandlerDeps {
    pokeEnabled: boolean;
    selfId(): string;
    dispatch(event: OneBotEvent): void;
    now?: () => number;
}
export declare function createPokeHandler(deps: PokeHandlerDeps): (event: OneBotEvent) => void;

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { constants, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { sessionIdForChat } from './chat.js';
import { describeError } from './errors.js';
/** The mapping file name inside the media dir. */
const MAPPING_FILE = 'chat-sessions.json';
/** The retired-session-id file name inside the media dir (append-only). */
const RETIRED_FILE = 'retired-sessions.json';
function persistEntry(sessionId, interimOverride, silentUntil) {
    const silent = silentUntil !== undefined && silentUntil > Date.now() ? silentUntil : undefined;
    if (interimOverride === undefined && silent === undefined)
        return sessionId;
    const entry = { session: sessionId };
    if (interimOverride !== undefined)
        entry.interimOverride = interimOverride;
    if (silent !== undefined)
        entry.silentUntil = silent;
    return entry;
}
/** The preset id a session's own record names: newest logged selection, else the creation header. */
export function resolveRecordedPreset(inspection) {
    const events = inspection.events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            return event.data.agentPreset;
        }
    }
    return inspection.meta.agentPreset;
}
/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export class ChatRegistry {
    deps;
    /** Live chats by chat id. */
    chats = new Map();
    /** Reverse index: session id → chat id (routes session events to chats). */
    bySession = new Map();
    chatSettings = new Map();
    brokenSessions = new Set();
    retiredSessionIds = new Set();
    mappingSaveTimer;
    /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
    mappingLoaded = Promise.resolve();
    constructor(deps) {
        this.deps = deps;
    }
    /** The (lazy-created) settings entry for one chat. */
    getSettings(chatId) {
        let settings = this.chatSettings.get(chatId);
        if (settings === undefined) {
            settings = {};
            this.chatSettings.set(chatId, settings);
        }
        return settings;
    }
    /** T3-board /silent: the still-open silence windows across all chats
     * (expired entries excluded). The bridge replays these into its in-memory
     * Map after loadMapping so a restart does not lift a running mute. */
    silenceWindows() {
        const windows = [];
        const now = Date.now();
        for (const [chatId, settings] of this.chatSettings) {
            if (settings.silentUntil !== undefined && settings.silentUntil > now)
                windows.push({ chatId, until: settings.silentUntil });
        }
        return windows;
    }
    // ------------------------------------------------------------ chat lifecycle
    /** C2: default-model wiring shared by the create and resume assembly paths
     * — the agent options for the registry call only (the deployment default
     * rides in as `provider`/`model`; dsh 0.2.2 carries the mutable selection
     * itself via `agent.model`, seeded from these options). Undefined fields
     * when the deployment has no default model. */
    modelWiring() {
        const selection = this.deps.defaultModel?.();
        const agentOptions = {};
        if (selection !== undefined) {
            agentOptions.provider = selection.provider;
            agentOptions.model = selection.model;
        }
        return agentOptions;
    }
    /** C2: the AgentSetup closure shared by the create and resume assembly
     * paths. The only difference between the callers is the preset: a resumed
     * session rejoins the preset it recorded itself; a fresh create reuses the
     * config/default resolution already recorded in its header meta. */
    buildSetup(recordedPreset) {
        return async (agentCtx) => {
            this.deps.installChannelScope(agentCtx);
            await this.joinPreset(agentCtx, recordedPreset);
            // Dual-host arity compat (#18): dsh 0.2.2 removed the ModelSelectionRef
            // type export and the second parameter (host-style single-arg install —
            // it only wires the model-switch notice listener; the selection itself
            // lives on agent.model), while the 0.2.1 host still expects
            // installModelSelection(agentCtx, selectionRef). Branch on the runtime
            // arity: the 0.2.1 form takes the selection fresh from defaultModel()
            // in a locally declared structural type (only when a default model
            // exists, matching the pre-0.2.2 wiring); otherwise the 0.2.2
            // unconditional single-arg install. Ignoring the returned disposer
            // matches the host callers (dsh-api-session-controller/dsh-headless/
            // dsh-acp).
            const install = installModelSelection;
            if (install.length >= 2) {
                const selection = this.deps.defaultModel?.();
                if (selection !== undefined) {
                    install(agentCtx, { current: selection, assembled: undefined });
                }
            }
            else {
                install(agentCtx);
            }
        };
    }
    /** C2: the ChatAgent literal shared by the create and resume assembly
     * paths — every field starts at its neutral initial value. `nickname` is
     * the one deliberate divergence between the callers (create seeds it from
     * the inbound message, resume keeps the pre-C2 hardcoded ''); pinned by
     * the M2-C2 characterization tests in bridge.spec.ts. */
    createChatAgent(chatId, handle, nickname) {
        return {
            chatId,
            sessionId: handle.agent.session.id,
            agent: handle.agent,
            dispose: () => handle.dispose(),
            lastActivityAt: Date.now(),
            loopPending: null,
            loopBuffer: [],
            recallTimers: new Map(),
            recalledInterimIds: new Set(),
            lastHandledMessageId: undefined,
            busy: false,
            dispatchTimes: [],
            rateLimitNoticeAt: undefined,
            typingTimer: undefined,
            lastNickname: nickname,
            pendingTurnRoles: [],
            activeTurnRole: 'member',
            lastFollowup: undefined,
        };
    }
    /** B8a: in-flight creates keyed by chat id — concurrent first messages for
     * one chat join a single create instead of racing (pre-B8a, two dispatches
     * could both pass the empty-map check and agents.create ran twice with the
     * same derived session id; the second chats.set won and the first agent
     * leaked). */
    pendingCreates = new Map();
    /** B8c: chats evicted for idleness, kept resumable (chat id → last session
     * id plus the D4b persisted-settings snapshot, since chatSettings is cleared
     * on eviction). NOT retired: saveMapping keeps writing them, so the mapping
     * file never drops an evicted chat and a later message resumes its session. */
    evictedChats = new Map();
    /** Get (or create) the agent for a chat. */
    async ensureChat(chatId, nickname) {
        const existing = this.chats.get(chatId);
        if (existing !== undefined)
            return existing;
        const pending = this.pendingCreates.get(chatId);
        if (pending !== undefined)
            return pending;
        const creation = this.createChat(chatId, nickname);
        this.pendingCreates.set(chatId, creation);
        void creation.finally(() => {
            this.pendingCreates.delete(chatId);
        }).catch(() => undefined);
        return creation;
    }
    async createChat(chatId, nickname) {
        await this.mappingLoaded;
        // B8c: a chat evicted for idleness resumes its recorded session instead
        // of forking a fresh one — the mapping entry was kept for exactly this.
        const evicted = this.evictedChats.get(chatId);
        if (evicted !== undefined) {
            if (this.isSessionIdBlocked(evicted.session)) {
                // T3: the snapshot records a retired session (resetChat keeps the
                // switch). Resuming it would resurrect retired history — skip the
                // resume, keep the settings, and fall through to a fresh create.
                this.restoreEvictedSettings(chatId, evicted);
                this.evictedChats.delete(chatId);
            }
            else {
                try {
                    const resumed = await this.resumeChat(chatId, evicted.session);
                    this.restoreEvictedSettings(chatId, evicted);
                    this.evictedChats.delete(chatId);
                    return resumed;
                }
                catch (error) {
                    this.retireSession(evicted.session);
                    // T3-R2: mirror the blocked-snapshot fast path above — the failed
                    // resume retires the session but must not lose the snapshot's
                    // settings: restore them onto chatSettings so the fresh create
                    // below keys them in (and, if that create also fails, saveMapping's
                    // settings-only fallback keeps writing them under the derived bare id).
                    this.restoreEvictedSettings(chatId, evicted);
                    this.evictedChats.delete(chatId);
                    this.deps.log('warn', 'resume of evicted session failed for ' + chatId + '; falling back to a fresh session: ' + describeError(error));
                }
            }
        }
        let sessionId = makeSessionId(sessionIdForChat(chatId));
        if (this.isSessionIdBlocked(sessionId)) {
            sessionId = this.freshSessionId(chatId);
        }
        else if (await this.hasPersistedLog(sessionId)) {
            // The bare id still owns a stale on-disk log (e.g. the retired record
            // was lost in an earlier crash): reusing it would collide, so retire it
            // NOW and move to a suffixed id instead of failing the chat later.
            this.retireSession(sessionId);
            sessionId = this.freshSessionId(chatId);
        }
        const agentOptions = this.modelWiring();
        const cwd = this.effectiveCwd(chatId);
        const presetId = await this.resolvePresetId(chatId);
        const meta = { cwd };
        if (presetId !== undefined)
            meta.agentPreset = presetId;
        const setup = this.buildSetup();
        let handle;
        try {
            handle = await this.deps.agents.create({
                sessionId,
                meta,
                agentOptions,
                setup,
            });
        }
        catch (error) {
            // A stale or foreign persisted log under the same id blocks creation
            // (id collision). Recover with a fresh suffixed session id instead of
            // failing the chat.
            this.retireSession(sessionId);
            const fallbackId = this.freshSessionId(chatId);
            this.deps.log('warn', 'agent create failed (' + describeError(error) + '); retrying with ' + fallbackId);
            handle = await this.deps.agents.create({
                sessionId: fallbackId,
                meta,
                agentOptions,
                setup,
            });
            this.deps.log('info', 'recovered with fresh session ' + fallbackId + ' for ' + chatId);
        }
        // The real session id is authoritative (the fallback path above creates a
        // different id than the one initially attempted); record it everywhere so
        // session events route to this chat and the mapping persists the truth.
        const actualSessionId = handle.agent.session.id;
        await this.attachToWorkspace(actualSessionId, handle.agent.session.header?.cwd);
        const chat = this.createChatAgent(chatId, handle, nickname);
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            // B8b: create succeeded but the first idle wait failed — dispose the
            // orphan agent instead of leaking it.
            try {
                await handle.dispose();
            }
            catch {
                // the whenIdle failure is the cause; a dispose failure must not mask it
            }
            throw error;
        }
        this.chats.set(chatId, chat);
        this.bySession.set(actualSessionId, chatId);
        this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')');
        void this.saveMapping();
        return chat;
    }
    restoreEvictedSettings(chatId, evicted) {
        const settings = this.getSettings(chatId);
        if (evicted.interimOverride !== undefined)
            settings.interimOverride = evicted.interimOverride;
        // T3-board /silent: only re-arm a window that is still open (expired
        // values are never restored).
        if (evicted.silentUntil !== undefined && evicted.silentUntil > Date.now())
            settings.silentUntil = evicted.silentUntil;
    }
    /** Resume persisted chats from the mapping file (best-effort). */
    async loadMapping() {
        let content;
        try {
            content = await readFile(this.mappingPath(), 'utf8');
        }
        catch (error) {
            // T4 (#15) inner split: a missing mapping file is the ordinary fresh
            // start — silent. Any other read failure warns (a silent "empty" here
            // would let a later saveMapping overwrite whatever is on disk, the
            // loadRetired hazard) but does not quarantine — the file may be
            // transiently unreadable rather than corrupt.
            if (error?.code !== 'ENOENT') {
                this.deps.log('warn', 'mapping read failed; starting fresh: ' + describeError(error));
            }
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch (error) {
            // T4 (#15): a parse failure is no longer silently swallowed — warn,
            // quarantine the file, and continue with an empty mapping.
            await this.quarantineCorruptMapping(error);
            return;
        }
        // T4 (#15): a structural failure (not a plain JSON object) takes the same
        // quarantine path as a parse failure.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            await this.quarantineCorruptMapping(new Error('mapping file is not a JSON object'));
            return;
        }
        const mapping = parsed;
        this.deps.log('debug', 'mapping file has ' + Object.keys(mapping).length + ' chat(s)');
        for (const [chatId, entry] of Object.entries(mapping)) {
            const sessionId = typeof entry === 'string' ? entry : entry?.session;
            if (typeof sessionId !== 'string' || sessionId === '')
                continue;
            // attempt (old files carry neither — the settings then fall back to
            // their current defaults). T3: restoring the override first closes the
            // hole where a failed resume (retire → fresh session) lost the
            if (typeof entry === 'object' && entry !== null) {
                const settings = this.getSettings(chatId);
                if (typeof entry.interimOverride === 'boolean')
                    settings.interimOverride = entry.interimOverride;
                // T3-board /silent: restore a still-open silence window (expired
                // values are dropped so a restart can never re-arm a stale mute).
                if (typeof entry.silentUntil === 'number' && entry.silentUntil > Date.now())
                    settings.silentUntil = entry.silentUntil;
            }
            // T3: a durably retired session id (recorded by resetChat's settings
            // snapshot) must never be resumed — the entry only carries the
            // settings for the chat's NEXT session. T3-R1 (review closure): keep
            // the object entry in evictedChats so any mid-flight saveMapping
            // (stop(), another chat's createChat) still writes it — a
            // settings-only chat sits in neither chats nor evictedChats, and one
            // before the next restart.
            if (this.retiredSessionIds.has(sessionId)) {
                this.deps.log('debug', 'skipping resume of retired session ' + sessionId + ' for ' + chatId + ' (settings only)');
                if (typeof entry === 'object' && entry !== null)
                    this.evictedChats.set(chatId, { session: entry.session, interimOverride: entry.interimOverride, silentUntil: entry.silentUntil });
                continue;
            }
            this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId);
            if (this.deps.isStopping())
                return;
            try {
                await this.resumeChat(chatId, sessionId);
            }
            catch (error) {
                this.retireSession(sessionId);
                // T3-R2: mirror the retired-skip branch above — keep the object
                // entry in evictedChats as a settings carrier so any later
                // saveMapping keeps writing it (otherwise one dropped save erases
                if (typeof entry === 'object' && entry !== null)
                    this.evictedChats.set(chatId, { session: entry.session, interimOverride: entry.interimOverride, silentUntil: entry.silentUntil });
                this.deps.log('warn', 'resume failed for ' + chatId + ': ' + describeError(error));
            }
        }
    }
    /** T4 (#15): quarantine an unparsable/structurally invalid mapping file —
     * warn, copy it to `<chat-sessions.json>.bak` (an existing .bak is never
     * overwritten: the earliest post-corruption copy wins), and leave the load
     * with an empty mapping so the chat stays usable. */
    async quarantineCorruptMapping(error) {
        this.deps.log('warn', 'mapping file is corrupt; quarantining to .bak and starting fresh: ' + describeError(error));
        try {
            await copyFile(this.mappingPath(), this.mappingPath() + '.bak', constants.COPYFILE_EXCL);
        }
        catch (copyError) {
            // EEXIST = a previous quarantine already holds the .bak — keep it.
            if (copyError?.code !== 'EEXIST') {
                this.deps.log('warn', 'mapping .bak copy failed: ' + describeError(copyError));
            }
        }
    }
    /** Resume one persisted chat from its recorded session id (shared by
     * loadMapping and the B8c evicted-chat resume). */
    async resumeChat(chatId, sessionId) {
        const agentOptions = this.modelWiring();
        const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId));
        const handle = await this.deps.agents.resume({
            resumeSessionId: makeSessionId(sessionId),
            agentOptions,
            setup: this.buildSetup(recordedPreset),
        });
        await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd);
        const chat = this.createChatAgent(chatId, handle, '');
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            // B8b: same orphan rule as the create path — dispose before rethrowing.
            try {
                await handle.dispose();
            }
            catch {
                // the whenIdle failure is the cause
            }
            throw error;
        }
        this.chats.set(chatId, chat);
        this.bySession.set(handle.agent.session.id, chatId);
        return chat;
    }
    mappingPath() {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + MAPPING_FILE
            : this.deps.config.mediaDir + '/' + MAPPING_FILE;
    }
    async saveMapping() {
        try {
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            const mapping = {};
            for (const [chatId, evicted] of this.evictedChats) {
                const live = this.chatSettings.get(chatId);
                mapping[chatId] = persistEntry(evicted.session, live?.interimOverride ?? evicted.interimOverride, live !== undefined ? live.silentUntil : evicted.silentUntil);
            }
            for (const chat of this.chats.values()) {
                const settings = this.chatSettings.get(chat.chatId);
                mapping[chat.chatId] = persistEntry(chat.sessionId, settings?.interimOverride, settings?.silentUntil);
            }
            for (const [chatId, settings] of this.chatSettings) {
                if (mapping[chatId] !== undefined)
                    continue;
                if (settings.interimOverride === undefined && (settings.silentUntil === undefined || settings.silentUntil <= Date.now()))
                    continue;
                mapping[chatId] = persistEntry(sessionIdForChat(chatId), settings.interimOverride, settings.silentUntil);
            }
            await writeFile(this.mappingPath(), JSON.stringify(mapping, null, 2), 'utf8');
        }
        catch (error) {
            this.deps.log('warn', 'mapping save failed: ' + describeError(error));
        }
    }
    saveMappingDebounced() {
        if (this.mappingSaveTimer !== undefined)
            clearTimeout(this.mappingSaveTimer);
        this.mappingSaveTimer = setTimeout(() => {
            this.mappingSaveTimer = undefined;
            void this.saveMapping();
        }, 2_000).unref();
    }
    /** B8c: dispose chats whose last activity is older than chatIdleEvictDays
     * (0 disables; default 7). Called before each inbound message: the session
     * is flushed, the agent disposed, and the chat removed from
     * chats/bySession/settings — NOT retired, the mapping keeps the pair so a
     * later message (or a restart) resumes the same session. */
    async sweepIdleChats() {
        const days = this.deps.config.chatIdleEvictDays ?? 7;
        if (days <= 0 || this.deps.isStopping())
            return;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        for (const [chatId, chat] of [...this.chats]) {
            if (chat.lastActivityAt > cutoff)
                continue;
            await this.evictChat(chatId, chat);
        }
    }
    async evictChat(chatId, chat) {
        // Only evict a session that is durably persisted; a failed flush keeps
        // the chat alive and the sweep retries on the next message.
        try {
            await this.deps.sessions.flush(chat.agent.session);
        }
        catch (error) {
            this.deps.log('warn', 'idle-evict flush failed for ' + chatId + ' (keeping the chat): ' + String(error));
            return;
        }
        this.deps.onChatRemoved(chat);
        this.clearInterimTimers(chat);
        this.chats.delete(chatId);
        this.bySession.delete(chat.sessionId);
        // D4b/T3: snapshot the persisted settings before the eviction clears them,
        // while it is idle.
        const evictedSettings = this.chatSettings.get(chatId);
        this.evictedChats.set(chatId, {
            session: chat.sessionId,
            interimOverride: evictedSettings?.interimOverride,
            silentUntil: evictedSettings?.silentUntil,
        });
        this.chatSettings.delete(chatId);
        try {
            await chat.dispose();
        }
        catch (error) {
            this.deps.log('warn', 'idle-evict dispose failed: ' + String(error));
        }
        this.deps.log('info', 'evicted idle chat ' + chatId + ' (session ' + chat.sessionId + ' kept resumable)');
    }
    // ------------------------------------------------------------ retired ids
    /** Whether a session id must never be created again (this run or on disk). */
    isSessionIdBlocked(id) {
        return this.brokenSessions.has(id) || this.retiredSessionIds.has(id);
    }
    /** A suffixed session id for a chat that avoids every blocked id. */
    freshSessionId(chatId) {
        let id;
        do {
            id = makeSessionId(sessionIdForChat(chatId) + '-' + Date.now().toString(36));
        } while (this.isSessionIdBlocked(id));
        return id;
    }
    /** Permanently retire a session id: in-memory plus durable on-disk record,
     * so a restart never reuses an id whose log collides with a fresh session. */
    retireSession(id) {
        this.brokenSessions.add(id);
        this.retiredSessionIds.add(id);
        void this.saveRetired();
    }
    brokenSessionCount() {
        return this.brokenSessions.size;
    }
    /** Whether the persistence layer already owns a durable log for this id —
     * true means reusing the id would collide (stale on-disk log or live entry).
     * A read failure counts as no log so the caller falls back to the normal
     * path rather than blocking an id on a transient error. */
    async hasPersistedLog(id) {
        const persistence = this.deps.sessionPersistence;
        if (persistence === undefined)
            return false;
        try {
            // 0.1.6 `stat` (the retired `inspect` no longer exists): a snapshot means
            // the id owns a durable log; missing or a read failure counts as no log.
            return (await persistence.stat(id)) !== undefined;
        }
        catch {
            return false;
        }
    }
    retiredPath() {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + RETIRED_FILE
            : this.deps.config.mediaDir + '/' + RETIRED_FILE;
    }
    async loadRetired() {
        let content;
        try {
            content = await readFile(this.retiredPath(), 'utf8');
        }
        catch (error) {
            // Only a missing file means "fresh start". ANY other read failure must
            // not be treated as an empty retired set — a later saveRetired() would
            // then OVERWRITE the on-disk record with nothing, silently dropping
            // every retired id (exactly the 2026-08-17 regression: the bare id
            // lost its retire record and /new collided on the stale log).
            if (error?.code !== 'ENOENT') {
                this.deps.log('warn', 'retired-sessions read failed; keeping the current set: ' + describeError(error));
            }
            return;
        }
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                this.retiredSessionIds = new Set(parsed.filter((id) => typeof id === 'string'));
                // Not backfilled into brokenSessions: the durable file cannot tell a
                // blocked union below already keeps every file id out of the create
                // paths. A genuinely broken id that is somehow targeted after a
                // restart fails inside switchSession's resume and falls back safely.
                this.deps.log('debug', 'retired-sessions file has ' + this.retiredSessionIds.size + ' id(s)');
            }
            else {
                this.deps.log('warn', 'retired-sessions file is not a JSON array; ignoring');
            }
        }
        catch (error) {
            // Corrupt JSON: keep the current in-memory set (never replace it with
            // an empty array) and warn so a future save does not obliterate history.
            this.deps.log('warn', 'retired-sessions file is unparsable; keeping the current set: ' + describeError(error));
        }
    }
    async saveRetired() {
        try {
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            // Atomic write: a temp file + rename never leaves a half-written file
            // that a concurrent/future loadRetired could parse into a broken empty set.
            // A UNIQUE tmp suffix per call: two concurrent saves sharing one fixed
            // `.tmp` name interleave so the later rename finds its tmp already
            // consumed by the earlier one (ENOENT, web log line 14251).
            const tmpPath = this.retiredPath() + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            await writeFile(tmpPath, JSON.stringify(Array.from(this.retiredSessionIds), null, 2), 'utf8');
            await rename(tmpPath, this.retiredPath());
        }
        catch (error) {
            this.deps.log('warn', 'retired-sessions save failed: ' + describeError(error));
        }
    }
    snapshotRetainedSettings(chatId, sessionId) {
        const settings = this.chatSettings.get(chatId);
        if (settings?.interimOverride !== undefined || (settings?.silentUntil !== undefined && settings.silentUntil > Date.now())) {
            this.evictedChats.set(chatId, { session: sessionId, interimOverride: settings.interimOverride, silentUntil: settings.silentUntil });
        }
    }
    /**
     * Recover from a session-log collision: the live session cannot append to
     * the mismatched on-disk log, so dispose the agent and rebuild the chat on
     * a fresh session id. The user is asked to resend.
     */
    async healSessionCollision(chatId) {
        const chat = this.chats.get(chatId);
        if (chat === undefined)
            return;
        // T3-R1 (review closure): same settings carrier as resetChat — without
        // the snapshot the trailing saveMapping drops the chat entirely (it sits
        // restart before the next message. Only persisted fields trigger it.
        this.snapshotRetainedSettings(chatId, chat.sessionId);
        this.retireSession(chat.sessionId);
        // The bare derived id shares the chat's stale log; retire it too so the
        // next ensureChat can never pick it again in this run OR after a restart.
        this.retireSession(sessionIdForChat(chatId));
        this.chats.delete(chatId);
        this.bySession.delete(chat.sessionId);
        this.deps.onChatRemoved(chat);
        try {
            await chat.dispose();
        }
        catch (error) {
            this.deps.log('warn', 'collision heal dispose failed: ' + String(error));
        }
        this.deps.log('warn', 'healed session collision for ' + chatId + '; a fresh session will be created on next message');
        void this.saveMapping();
    }
    effectiveCwd(_chatId) {
        return this.deps.config.workspacePath || process.cwd();
    }
    /**
     * The preset id a NEW session records and joins: the configured id when set,
     * else the deployment default — the same resolution the Web surface applies,
     * so cross-channel sessions carry the same header fact. A roster that cannot
     * resolve the effective id leaves the header bare and the session uncomposed,
     * exactly like a failed mount.
     */
    async resolvePresetId(chatId) {
        const presets = this.deps.agentPresets;
        if (presets === undefined)
            return undefined;
        // 权限分档 A3: 群聊粗档——配置了 agentPresetGroup 时群聊会话优先用它
        // 仍然最优先）。
        const groupPreset = this.deps.config.agentPresetGroup;
        const isGroupChat = chatId !== undefined && chatId.startsWith('group:');
        const base = this.deps.config.agentPreset;
        const configured = isGroupChat && groupPreset !== undefined && groupPreset !== ''
            ? groupPreset
            : base;
        const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId;
        try {
            const preset = await presets.resolve(wanted);
            return preset.id;
        }
        catch (error) {
            this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + describeError(error));
            return undefined;
        }
    }
    /**
     * The preset id a persisted session recorded for itself (newest logged
     * selection wins, else the creation header), or undefined when it recorded
     * none or the record cannot be read — a legacy session resumes under the
     * config/default, preserving its original behavior.
     */
    async recordedPresetFor(sessionId) {
        const persistence = this.deps.sessionPersistence;
        if (persistence === undefined)
            return undefined;
        // 0.1.6 has no `inspect`: read the same record through open('read') — the
        // immutable header carries the creation preset, the full event log the
        // newest `agent-preset/selected`. The handle MUST close even on failure
        // (AsyncDisposable — a leaked read handle pins backend resources).
        let handle;
        try {
            handle = await persistence.open(sessionId, 'read');
            return resolveRecordedPreset({
                meta: { agentPreset: handle.header.agentPreset },
                events: (await handle.read()).events,
            });
        }
        catch (error) {
            this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + describeError(error));
            return undefined;
        }
        finally {
            if (handle !== undefined) {
                try {
                    await handle.close();
                }
                catch {
                    // Best-effort teardown: the read outcome above already decided.
                }
            }
        }
    }
    /**
     * Join the QQ agent to the configured agent preset (the deployment default
     * when unset) so its tools/prompt sections/skill catalog resolve against the
     * preset composition instead of the empty global layer. `preferred` — the
     * preset the session itself recorded — overrides the config (its history was
     * produced under that composition; replaying it differently would break the
     * recorded tool calls); a conflicting config only logs. Best-effort: a
     * broken preset falls back to the previous behavior rather than failing the
     * chat.
     */
    async joinPreset(agentCtx, preferred) {
        if (this.deps.agentPresets === undefined)
            return;
        const configured = this.deps.config.agentPreset;
        if (preferred !== undefined && configured !== undefined && configured !== '' && configured !== preferred) {
            this.deps.log('warn', 'session records preset ' + preferred + ' but plugin config names ' + configured + '; resuming under the recorded preset');
        }
        const selected = preferred ?? (configured !== undefined && configured !== '' ? configured : undefined);
        try {
            const preset = await this.deps.agentPresets.mount(agentCtx, selected);
            this.deps.log('debug', 'agent joined preset ' + preset.id);
        }
        catch (error) {
            this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + describeError(error));
        }
    }
    /**
     * Attach a chat session to the workspace owning its header cwd, so QQ
     * sessions group under a workspace in the GUI instead of "Ungrouped".
     * Best-effort: failure only logs.
     *
     * A workspace is auto-created only when the session cwd matches the
     * configured workspacePath (new sessions). A resumed session carrying a
     * foreign cwd (e.g. created under an earlier host cwd) is attached only when
     * a workspace already owns that path — never auto-created, so legacy
     * sessions cannot spawn accidental workspaces.
     */
    async attachToWorkspace(sessionId, headerCwd) {
        const registry = this.deps.workspaceRegistry;
        if (registry === undefined)
            return;
        try {
            if (headerCwd === undefined || headerCwd === '') {
                this.deps.log('warn', 'workspace attach skipped: session header carries no cwd');
                return;
            }
            const workspace = await registry.resolveByPath(headerCwd);
            if (workspace === undefined) {
                if (headerCwd !== this.effectiveCwd()) {
                    this.deps.log('debug', 'workspace attach skipped: no workspace owns ' + headerCwd + ' and it differs from the configured workspacePath');
                    return;
                }
                const created = await registry.create(headerCwd);
                this.deps.log('info', 'created workspace for ' + headerCwd);
                await created.attachSession(sessionId);
                this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd);
                return;
            }
            await workspace.attachSession(sessionId);
            this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd);
        }
        catch (error) {
            this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + describeError(error));
        }
    }
    async resetChat(chatId) {
        const chat = this.chats.get(chatId);
        if (chat !== undefined) {
            // T3 (hole C): keep the mapping entry alive across the reset — without a
            // snapshot the trailing saveMapping drops the chat entirely (it sits in
            // id is never resumed: createChat skips blocked snapshots and loadMapping
            // skips durably retired ids. Only persisted fields trigger the snapshot —
            // a plain /new keeps the exact pre-T3 on-disk behavior (entry dropped).
            // T3-R1 (review): the identical snapshot now also covers collision heals.
            this.snapshotRetainedSettings(chatId, chat.sessionId);
            this.deps.onChatRemoved(chat);
            this.clearInterimTimers(chat);
            // SOFT retire (not brokenSessions): the old session's history is
            // record still keeps the id out of every create path (blocked union).
            this.retiredSessionIds.add(chat.sessionId);
            void this.saveRetired();
            // The bare derived id is forever unsafe for this chat once its history
            // has moved to a suffixed id: its on-disk log (if any) would collide
            // with any future bare-id session. Retire it up front so a /new after a
            // restart — when only the retired file protects us — stays safe.
            // Skipped when it IS the current session (a first-generation /new): the
            // soft retire above already covers it, and a hard retire would mark the
            const bareId = sessionIdForChat(chatId);
            if (bareId !== chat.sessionId)
                this.retireSession(bareId);
            this.chats.delete(chatId);
            this.bySession.delete(chat.sessionId);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'reset dispose failed: ' + describeError(error));
            }
            this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + chat.sessionId + ' retired)');
        }
        void this.saveMapping();
    }
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    async sessionIdFromMapping(chatId) {
        const file = joinMappingPath(this.deps.config.mediaDir);
        try {
            const text = await readFile(file, 'utf8');
            const map = JSON.parse(text);
            const entry = map[chatId];
            const id = typeof entry === 'string' ? entry : entry?.session;
            return typeof id === 'string' && id !== '' ? id : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** Clear every pending interim auto-recall timer for a chat (dispose path). */
    clearInterimTimers(chat) {
        for (const timer of chat.recallTimers.values())
            clearTimeout(timer);
        chat.recallTimers.clear();
    }
    /** Stop everything registry-owned: cancel the debounce timer, save the
     * mapping, dispose every agent, clear both indexes. */
    async stop() {
        if (this.mappingSaveTimer !== undefined) {
            clearTimeout(this.mappingSaveTimer);
            this.mappingSaveTimer = undefined;
        }
        await this.saveMapping();
        for (const chat of this.chats.values()) {
            this.deps.onChatRemoved(chat);
            this.clearInterimTimers(chat);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'agent dispose failed: ' + String(error));
            }
        }
        this.chats.clear();
        this.bySession.clear();
    }
}
/** Join the mapping file name onto the media dir (no trailing-separator loss). */
function joinMappingPath(mediaDir) {
    return mediaDir.endsWith('/') || mediaDir.endsWith('\\')
        ? mediaDir + MAPPING_FILE
        : mediaDir + '/' + MAPPING_FILE;
}

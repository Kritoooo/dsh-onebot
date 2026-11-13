export function createPokeHandler(deps) {
    const throttle = new Map();
    const now = deps.now ?? (() => Date.now());
    return event => {
        if (!deps.pokeEnabled || event.post_type !== 'notice')
            return;
        if (event.notice_type !== 'poke' && !(event.notice_type === 'notify' && event.sub_type === 'poke'))
            return;
        const userId = String(event.user_id ?? '');
        const selfId = deps.selfId();
        if (userId === '' || selfId === '' || userId === selfId || String(event.target_id ?? '') !== selfId)
            return;
        const groupId = String(event.group_id ?? '');
        const kind = groupId !== '' ? 'group' : 'private';
        const at = now();
        const key = kind + ':' + (groupId || userId) + ':' + userId;
        const last = throttle.get(key);
        if (last !== undefined && at - last < 3_000)
            return;
        if (throttle.size > 200) {
            for (const [entry, seenAt] of throttle) {
                if (at - seenAt >= 60_000)
                    throttle.delete(entry);
            }
        }
        throttle.set(key, at);
        const message = [{ type: 'text', data: { text: '[戳一戳]' } }];
        if (kind === 'group')
            message.push({ type: 'at', data: { qq: selfId } });
        // A notice has no actual message ID; do not invent a native reply target.
        deps.dispatch({
            post_type: 'message', message_type: kind, self_id: selfId,
            user_id: userId, ...(groupId !== '' ? { group_id: groupId } : {}),
            time: Math.floor(at / 1000), message, raw_message: '[戳一戳]',
            sender: { user_id: userId, nickname: '' },
        });
    };
}

# dsh-onebot

> **English | [中文](README.md)**

A OneBot 11 QQ channel for dsh (DeepSeek Harness), compatible with SnowLuma, NapCat and other OneBot peers. Current fork: **0.9.19-kirito.3**.

The plugin handles transport, message conversion, QQ access control and one persistent Agent per chat. Models, presets and workspaces are configured through the host or plugin configuration.

## Retained features

- Forward/reverse WebSocket, token authentication, get_status liveness probes, reconnect/backoff and recovery.
- Private/group messages, CQ and segment parsing, mention/reply gates, images/stickers/files/voice, quoted images and merged forwards.
- Text and rendered image cards, native replies, ACP metadata cleaning, media sending, optional poke handling.
- Per-chat persistence, restart recovery, /new with collision-safe session retirement, idle eviction.
- Access lists, member tool gates, deduplication, rate limits, outbound audit and media/download boundaries.
- Intermediate messages, recall/summary cards, queue/steer behavior, local STT, timeout delivery, tracing, diagnostics and the settings panel.

## Scope reduction in this version

Removed: /goal; /plan, /permission, /workspace; /model, /preset; /session switching; QQ-specific structured question/plan-card bridges; raw inbound recording, file event injection, dry-run interception and replay; and the standalone /ocr command.

Old goals and per-chat workspace overrides are ignored and no longer persisted. Existing session logs and restart recovery remain; /new retires old IDs without overwriting their logs. Recorded presets still follow the resumed host session. The old switchable-sessions.json file is no longer used.

Legacy debug keys recordInbound, inboxRedact, injectEnabled, injectDryRun and injectIntervalMs have no execution path and are not writable through the settings service. Remove them from deployment configuration when convenient. Diagnostic archives retain trace/audit/config/report artifacts but omit old raw inbox recordings.

Native image understanding remains available when the host preset provides an image tool. The retained qq_napcat_api continues to use its API allowlist, including its existing OCR API access.

## Commands

Administrators: /new, /stop, /steer, /status, /doctor, /retry, /id, /ver, /silent, /mode and /help. /healthcheck aliases /doctor. Ordinary members receive a restricted /help view.

/doctor supports export [reference] and test. /silent defaults to 30 minutes; an argument-free repeat lifts it early. /mode accepts interim or instant. Unknown commands follow unknownCommand (intercept by default). Ordinary numbers, answer prefixes and “skip” text are no longer consumed by selection or question state.

## Configuration

See [src/index.ts](src/index.ts) for the schema. The settings panel retains 25 fields in connection, permissions, behavior and diagnostics groups.

Connection/authentication and existing defaults remain unchanged: reverse, loopback:8643, queue policy, 150-character text-image threshold, tracing off, outbound audit on. Configure adminUsers, private/group policies and access lists for your deployment.

Global agentPreset, agentPresetGroup and workspacePath still control new-session assembly. pokeEnabled defaults to false; enabling it accepts only explicit pokes to a known bot identity, throttled per sender/chat for three seconds and subject to existing access policy. maxQuoteDepth defaults to 1, accepts integers 0–5, and stops cycles.

Retained tools: qq_send_image, qq_send_voice, qq_send_video, qq_send_file, qq_send_forward, qq_send_segments, qq_napcat_api and qq_group_history. Member turns are blocked by default; permissions.memberTools: all explicitly allows them.

A leading [[reply:<mid>]] creates a native QQ reply, including negative IDs, rendered cards and reconnect delivery. The same syntax inside prose stays literal. Images are resolved to local paths; image tools and their file permissions remain the host preset's responsibility.

## Build and validate

Use the Node runtime and peer packages of your dsh host. Validation targets dsh 0.2.2-rc.1 / Node 24.22.2. The same-name npm package belongs to upstream; use the matching local archive or source checkout for this fork.

    npm install
    DSH_ROOT=<host node_modules root> ./scripts/build.sh
    npx tsc --noEmit
    npx vitest run
    npm pack

Install development dependencies once, then link/build against the host. build.sh generates JS/declarations from src/, copies the canonical client/index.js browser source to lib/client.js, and removes obsolete generated modules. Do not edit lib/ manually.

Text-image rendering and inbound image shrinking both use canvas. fontkit supports text-card fonts; silk-wasm supports local STT. The retained verify:injected-context script checks host session provenance and is separate from the removed file injection feature. verify:lan-management remains available.

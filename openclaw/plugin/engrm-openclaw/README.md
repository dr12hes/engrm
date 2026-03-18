# Engrm OpenClaw Plugin

Native OpenClaw integration for [Engrm](https://engrm.dev).

Engrm gives OpenClaw shared memory across devices, sessions, and agents. The same memory layer can be reused across OpenClaw, Claude Code, and Codex.

## What It Does

- injects a compact Engrm startup brief before prompt build
- exposes real Engrm tools inside OpenClaw
- adds a native `/engrm` command with `connect`, `status`, and `disconnect`
- saves a session digest and structured memory after successful agent runs
- emits OpenClaw telemetry so the Engrm dashboard can identify OpenClaw activity
- supports general work context, not only coding sessions

## Included OpenClaw Tools

- `engrm_status`
- `engrm_connect`
- `engrm_recent`
- `engrm_search`
- `engrm_delivery_review`

## Install

```bash
openclaw plugins install engrm-openclaw-plugin
```

Then restart OpenClaw or the OpenClaw gateway.

## Update

If the plugin is already installed, update it in place instead of reinstalling:

```bash
openclaw plugins update engrm
```

To update all npm-installed plugins at once:

```bash
openclaw plugins update --all
```

OpenClaw tracks npm-installed plugins and updates them cleanly once the first install has happened.

## Connect

In an OpenClaw chat:

```text
/engrm connect
```

That opens browser auth and links the current OpenClaw machine to your Engrm account.

You can verify with:

```text
/engrm status
```

## Notes

- This plugin stays quiet if Engrm is not connected yet.
- Older low-signal OpenClaw session data may still appear in the dashboard until newer, cleaner sessions replace it.
- Source lives in the public Engrm repo: [github.com/dr12hes/engrm](https://github.com/dr12hes/engrm)

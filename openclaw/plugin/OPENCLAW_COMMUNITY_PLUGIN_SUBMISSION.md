# OpenClaw Community Plugin Submission

Plugin name: `Engrm`

NPM package:

```text
engrm-openclaw-plugin
```

Install command:

```bash
openclaw plugins install engrm-openclaw-plugin
```

GitHub repo:

```text
https://github.com/dr12hes/engrm
```

Plugin source directory:

```text
openclaw/plugin/engrm-openclaw
```

Short description:

```text
Shared memory for OpenClaw across devices, sessions, and agents, with continuity across OpenClaw, Claude Code, and Codex.
```

Suggested listing copy:

```text
Engrm gives OpenClaw shared memory across devices, sessions, and agents, so work can continue on another machine or in another coding system without starting cold. It injects a startup brief before prompt build and saves structured session memory after successful runs.
```

Suggested install / setup notes:

```text
Install with `openclaw plugins install engrm-openclaw-plugin`, restart OpenClaw, then run `/engrm connect` in chat to link the machine to your Engrm account.
```

Suggested update note:

```text
Once installed, users can update in place with `openclaw plugins update engrm` instead of reinstalling.
```

Operational note:

```text
The npm package name is `engrm-openclaw-plugin`, but the stable OpenClaw plugin id and chat command remain `engrm`. This keeps user config stable across updates even though OpenClaw may still surface a non-fatal identity hint in some versions.
```

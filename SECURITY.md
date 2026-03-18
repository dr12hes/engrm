# Security Policy

## Reporting a Vulnerability

Please do not open public GitHub issues for security-sensitive problems.

Email: [hello@engrm.dev](mailto:hello@engrm.dev)

Include:
- affected version or commit
- impact
- reproduction steps
- whether the issue affects local-only use, sync, or team/shared memory

We will acknowledge receipt and work with you on coordinated disclosure.

## High-Sensitivity Areas

Please report privately if your finding involves:
- secret scrubbing failures
- incorrect visibility of personal or secret observations
- sync or tenancy leaks
- prompt-injection or tool-execution risks
- Sentinel bypasses

## Scope

This repository covers the Engrm open-core client, including:
- CLI
- MCP server
- local storage
- sync client behavior
- agent hooks in this repo

Hosted services and proprietary Sentinel infrastructure may be handled separately during triage.

# Roadmap

This roadmap reflects the next practical phase for Engrm: make the local memory product feel obviously valuable, raise dashboard usefulness, keep benchmark credibility moving up, and get ahead of the security questions we know are coming.

## Product Shape

Engrm should feel like one system with three connected layers:

- `Memory` restores context across sessions, devices, and agents
- `Delivery Review` checks whether the work matched the brief
- `Sentinel` acts as the safety net that catches common mistakes before they ship

The public story stays:

- shared memory across devices, agents, and teams

The product value underneath it becomes clearer:

- remember what happened
- show what was delivered
- prevent obvious mistakes from shipping

## Next Sprint

### 1. Make Local SQLite Memory The Primary Product Experience

Most real users will judge Engrm by the local memory feel before they care about cloud sync architecture.

Priority work:

- improve local SQLite retrieval quality for recent and repeated work
- promote richer local memory objects, not just generic chunks
- store more first-class facts locally:
  - identity
  - decisions
  - lessons
  - plans
  - dated events
- tighten startup briefs so they surface:
  - investigated
  - learned
  - completed
  - next steps

Success looks like:

- Claude, Codex, and OpenClaw start less cold
- repeated work feels obviously easier
- lessons learned show up where they matter

### 2. Turn Sentinel Into The Real Vibe-Coder Safety Net

Sentinel should expand from "security preflight" into the practical Guardian layer for fast-moving users.

Priority work:

- broaden Sentinel checks beyond pure security
- keep security checks front and center:
  - hardcoded secrets
  - missing auth
  - SQL injection
  - exposed admin routes
  - weak crypto
- add momentum-preserving advisory UX for Vibe / Pro
- keep blocking mode for Team
- make Sentinel aware of prior mistakes and learned patterns from Engrm memory

Public product framing:

- shared memory is the hero
- Sentinel is the safety net
- Delivery Review is the accountability layer

### 3. Make The Dashboard Worth Visiting

The dashboard should stop reading like a thin observation log and start showing concrete value.

Priority work:

- add stronger session briefs view:
  - request
  - investigated
  - learned
  - completed
  - next steps
- add useful metrics, not vanity counts:
  - risky changes prevented
  - repeated mistake categories
  - lessons reused
  - unresolved risks
  - reopened-after-done work
- add clearer device and agent attribution:
  - OpenClaw
  - Claude Code
  - Codex
- make team memory health visible:
  - review backlog
  - knowledge reuse
  - drift between requested and delivered work

Success looks like:

- a user can open the dashboard and immediately see why Engrm helped
- teams can see what is improving and what keeps going wrong

### 4. Keep MemoryBench Honest And Competitive

Benchmarks matter, but they should support product work rather than drive overfitting.

Current benchmark direction:

- 10-question LoCoMo slice reached strong results with structured fact docs
- 50-question run shows the real remaining weakness is single-hop fact coverage, not general retrieval

Priority work:

- keep the new structured fact extraction direction
- expand fact coverage carefully without exploding ingest cost
- improve single-hop fact recall before chasing more ranking complexity
- maintain the current strengths:
  - temporal questions
  - multi-hop questions
- benchmark both:
  - hosted beta API
  - local SQLite-first retrieval path where possible

Rules:

- do not optimize blindly for one benchmark prompt
- treat 50-question slices as the minimum believable checkpoint
- use benchmark failures to identify missing memory-object types

### 5. Prepare The Ground For Better MCP And Agent Integrations

Before pushing harder on the Engrm MCP story, the foundations should be stronger.

Priority work:

- improve the memory objects the MCP server can search and return
- return better grouped evidence, not just flat hits
- make local and shared memory behavior consistent across:
  - Claude Code
  - Codex
  - OpenClaw
- ensure OpenClaw keeps moving from "connected" to "actually useful memory"

## Security And Trust

We should assume security objections will come up soon and prepare before they become blockers.

### Immediate Prep

- publish a clearer security/trust page
- document what Engrm stores locally vs what syncs
- explain what metadata exists and why
- document retention, deletion, and device revocation behavior
- make secret handling and logging posture explicit

### Product/Sales Readiness

- prepare clear answers for:
  - proprietary code concerns
  - client-work concerns
  - cloud-sync concerns
  - local-only vs synced usage
- do not overclaim compliance
- position privacy/security as practical and defensible

### Future Privacy Work

End-to-end encryption is strategically strong, but should follow product clarity, not replace it.

Recommended framing:

- local-first memory is the base
- private sync is the premium trust layer
- solo encrypted sync likely comes before team encrypted sync

## Execution Order

1. local SQLite memory quality and startup-brief usefulness
2. Sentinel expansion into the real vibe-coder safety net
3. dashboard metrics and session-value views
4. broader 50+ question benchmark improvement focused on fact coverage
5. deeper MCP and OpenClaw memory quality improvements
6. security/trust page and objection handling
7. privacy / E2EE design once the core flows are solid

## Proof And Moat

The moat is not "we store vectors".

It is:

- shared memory across devices and agents
- useful local-first recall
- accountability through Delivery Review
- a safety net through Sentinel
- better team memory over time

That is the shape Engrm should keep reinforcing.

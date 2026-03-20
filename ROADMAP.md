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

## Strategic Pivot: Thin Tools, Thick Memory

We should be willing to pivot the product shape if the market starts rewarding thinner tool surfaces and stronger memory layers more than raw MCP breadth.

The moat is still:

- cross-device memory
- cross-agent memory
- shared project memory that survives tool and model changes

But the implementation strategy may need to evolve.

### Why This Matters

If we keep adding more direct tooling for:

- git diffs
- repo scans
- filesystem inspection
- issue trackers
- CI/build systems
- deployment/status systems
- external APIs

then we inherit two problems:

1. tool-schema/context bloat
2. raw result/output bloat

Projects like `mcp2cli` point at a real trend:

- make large tool surfaces cheaper to expose at runtime
- avoid paying repeated context costs for tool schemas every turn

Engrm should care because memory providers should own:

- what gets called
- what gets compressed
- what gets remembered

Not just what gets stored.

### Working Thesis

The right long-term architecture is likely:

- thin tool surface
- thick memory layer

Meaning:

- do not expose every possible tool in the prompt by default
- use thin connectors or runtime wrappers to reach large tool ecosystems
- let Engrm decide what from those tool calls becomes durable memory

This keeps Engrm aligned with the real moat:

- the memory follows the work
- not the particular tool transport

## Engrm Plugin Ecosystem Direction

The plugin model should not just mean “more tools”.

An Engrm plugin should mean:

1. `Connector`
- how to reach the source:
  - MCP
  - CLI
  - OpenAPI
  - GraphQL
  - local command
  - file scan

2. `Reducer`
- how to shrink raw output into useful signal
- avoid storing giant blobs and repeated noise

3. `Extractor`
- how to turn results into memory objects:
  - bugfixes
  - features
  - decisions
  - discoveries
  - risks
  - next actions
  - standards

4. `Presenter`
- how the extracted memory shows up in:
  - startup briefs
  - Briefs
  - Delivery Review
  - Sentinel
  - Insights

That is a stronger plugin story than “we also connect to another API”.

## Plugin Tiers

### 1. Source Plugins

These add reach into useful systems.

Examples:

- `git`
- `repo-scan`
- `filesystem`
- `ci`
- `issues`
- `docs`
- `deploy`
- `openclaw-content`

Their job is:

- get the data
- normalize it
- keep the access surface thin

### 2. Memory Plugins

These decide what to save.

Examples:

- `code-change-extractor`
- `bugfix-extractor`
- `decision-extractor`
- `risk-extractor`
- `content-outcome-extractor`
- `release-extractor`

Their job is:

- turn raw tool output into durable memory objects

### 3. Workflow Plugins

These shape the product experience around a repeatable workflow.

Examples:

- `openclaw-content-ops`
- `coding-session-review`
- `release-readiness`
- `repo-health`
- `sentinel-safety`

Their job is:

- connect source plugins + memory plugins + presentation rules

## Relationship To mcp2cli

Engrm should not try to become `mcp2cli`.

Instead:

- `mcp2cli`-style tooling can be part of the connector layer
- Engrm should own the memory layer above it

What that means in practice:

- a connector can expose a large tool universe cheaply
- Engrm decides:
  - which commands mattered
  - which outputs were worth saving
  - how those outputs should appear later

So the opportunity is not:

- “copy mcp2cli”

It is:

- adopt the same context-efficiency instinct
- then build the memory and presentation moat above it

## Proposed Plugin Spec

Each plugin should have a lightweight manifest with:

- `id`
- `type` (`source`, `memory`, `workflow`)
- `connector`
- `auth_requirements`
- `input_shape`
- `reducer_rules`
- `extractor_rules`
- `presentation_targets`
- `sensitivity_defaults`
- `project_mapping_rules`

For workflow plugins, add:

- `brief_tabs`
- `sentinel_hooks`
- `delivery_review_rules`
- `insight_metrics`

## First Plugin Candidates

These are the highest-value early candidates.

### 1. Git / Diff Plugin

Purpose:

- extract useful memory from diffs and repo state without dumping raw git output into context

Capture:

- changed files
- likely bugfixes
- reverted work
- risky auth/security changes
- migrations
- shipped features

Presentation:

- Briefs
- Delivery Review
- Sentinel

### 2. Repo Scan Plugin

Purpose:

- bring in findings from filesystem or repo scans without bloating transcripts

Capture:

- risk findings
- repeated anti-patterns
- architecture notes
- dependency / secret / auth problems

Presentation:

- Sentinel
- Insights
- Briefs

### 3. OpenClaw Content Plugin

Purpose:

- treat OpenClaw content and engagement workflows as real memory, not a bad fit for coding-session templates

Capture:

- posted items
- researched items
- campaign/topic focus
- next actions
- outcomes

Presentation:

- Briefs
- project rollups
- content-focused insights

### 4. Issue Tracker Plugin

Purpose:

- connect implementation memory to explicit work items

Capture:

- issue references
- status changes
- blockers
- reopened work

Presentation:

- Delivery Review
- Briefs
- project trends

### 5. CI / Release Plugin

Purpose:

- remember what failed, what passed, and what changed before release

Capture:

- release blockers
- flaky checks
- regression points
- deploy outcomes

Presentation:

- Sentinel
- release readiness views
- Briefs / Insights

## Execution Plan For This Pivot

### Phase A: Plugin Foundation

Primary repo:

- `candengo-mem`

Work:

- define plugin manifest shape
- define reducer/extractor interfaces
- define presentation targets
- support local plugin registration

Done looks like:

- Engrm can register plugins without adding ad-hoc special cases everywhere

### Phase B: Briefs And Startup Integration

Primary repos:

- `candengo-mem`
- `candengo-vector`

Work:

- let plugins add typed memory objects
- let startup briefs consume those objects
- let Briefs show plugin-native tabs and filters

Done looks like:

- Briefs is no longer just generic session formatting
- plugin-shaped memory appears naturally in the product

### Phase C: Sentinel And Review Integration

Primary repos:

- `candengo-mem`
- `candengo-vector`

Work:

- let plugins emit risks and standards
- let Delivery Review consume plugin output where relevant
- let Sentinel use extracted patterns instead of only raw scans

Done looks like:

- plugins strengthen the safety net and review layers, not just data volume

### Phase D: Ecosystem Packaging

Primary repo:

- `candengo-mem`

Work:

- package first-party plugins
- publish docs for plugin authors
- add plugin packs / install flow

Done looks like:

- Engrm has the start of a real ecosystem, not just internal integrations

## Claude-Mem Lessons: Capture Fidelity First

After reviewing the local `claude-mem` codebase in depth, the clearest lesson is:

- their advantage is not just search quality
- it is capture fidelity, chronology, and retrieval ergonomics

What they are doing materially better:

1. **First-class user prompt capture**
   - raw prompts are stored in their own table and searchable
   - prompts are tied to `prompt_number`, session identity, and project

2. **Richer observation shape**
   - observations include:
     - `tool_name`
     - `title`
     - `subtitle`
     - `narrative`
     - `facts`
     - `concepts`
     - `files_read`
     - `files_modified`
     - `prompt_number`
     - `discovery_tokens`
   - this lets them reconstruct the working story, not just the outcome

3. **Worker-backed asynchronous compression**
   - hooks send rich raw events to a long-lived worker
   - compression happens asynchronously, so hooks stay fast while stored memory stays detailed

4. **Timeline that includes prompts, observations, and summaries**
   - they can show a real sequence of:
     - user asked
     - tools ran
     - learnings were extracted
     - summary was produced

5. **Startup context as a memory console**
   - typed index
   - IDs
   - file grouping
   - token economics
   - explicit follow-up retrieval path

What we should copy in principle, not in presentation:

- first-class prompt capture
- richer raw tool event storage
- chronology and prompt numbering
- async reducer/compression pipeline
- startup index with token/value metrics
- timeline/search over prompts + observations + summaries

What we should not copy blindly:

- every UX choice
- all of their runtime/worker complexity
- raw transcript hoarding without reduction rules

Our job is to combine:

- `claude-mem`-level capture fidelity
- Engrm's cross-device, cross-agent sync
- thin-tool / thick-memory plugin architecture

## Execution Order

1. capture fidelity upgrade: prompts, tool events, chronology, richer observation schema
2. startup memory console: typed index, IDs, token economics, retrieval affordances
3. local SQLite memory quality and startup usefulness
4. OpenClaw briefs and Briefs-as-surface cleanup
5. plugin foundation for thin-tool / thick-memory architecture
6. dashboard metrics and typed project views
7. Sentinel expansion into the real vibe-coder safety net
8. first source + memory plugins (`git`, `repo-scan`, `openclaw-content`)
9. broader 50+ question benchmark improvement focused on fact coverage
10. deeper MCP and OpenClaw memory quality improvements
11. security/trust page and objection handling
12. privacy / E2EE design once the core flows are solid

## Next Phase Sprint Plan

This next phase should be treated as one coordinated sprint across the client, hosted dashboard, and OpenClaw surfaces.

### Workstream 1: Capture Fidelity Upgrade

Goal:

- make Engrm capture enough detail to reconstruct the real working story, not just the final summary

Primary repo:

- `candengo-mem`

Work:

- add first-class prompt capture with prompt numbering
- add raw tool event ledger for high-value tool usage
- extend observation schema toward richer fields where useful:
  - subtitle
  - source tool
  - prompt number
  - richer provenance
- keep privacy controls and reduction rules so we do not become a noisy surveillance log
- evaluate whether the current hook-only path should evolve toward a lightweight async reducer worker

Done looks like:

- Engrm can answer:
  - what the user asked
  - what tools ran
  - what was learned
  - what was completed
  - in what order
- the stored data is rich enough to support a serious startup index and timeline

### Workstream 2: Startup Memory Console

Goal:

- make the startup moment feel obviously powerful within seconds

Primary repo:

- `candengo-mem`

Work:

- replace the thin startup brief with a richer startup index
- show typed entries with IDs and file/project grouping
- add context economics:
  - observations loaded
  - searchable total
  - estimated read cost
  - estimated reuse savings
- add explicit follow-up affordances:
  - fetch by ID
  - search deeper
  - inspect recent bugfixes / decisions / prompts

Done looks like:

- Engrm startup no longer feels like a tiny digest
- it feels like a serious memory console
- it compares credibly with claude-mem's startup depth while staying true to Engrm's UX

### Workstream 3: OpenClaw Briefs First

Goal:

- make OpenClaw-derived memory look useful without requiring users to mentally unwrap cron prompts or session wrappers

Primary repo:

- `candengo-vector`

Work:

- keep stripping operational wrappers from OpenClaw requests and headlines
- prefer actual shipped outcome lines for brief headlines
- group OpenClaw brief content into typed lanes:
  - posted
  - investigated
  - learned
  - completed
  - next actions
- make content/ops sessions read as useful work, not fake coding recaps

Done looks like:

- OpenClaw briefs no longer lead with cron/job prompts
- the top visible line is the real outcome
- content and engagement sessions still feel like useful project memory

### Workstream 4: Briefs Becomes The Main Dashboard Surface

Goal:

- turn `Briefs` into the main factual memory view by project before adding more inference

Primary repo:

- `candengo-vector`

Work:

- keep `Sessions` hidden and route users to `Briefs`
- add project/repo filtering to `Briefs`
- add typed project rollups for:
  - bugfixes
  - features
  - changes
  - decisions
  - discoveries
- let users move from all-briefs view to project-specific view cleanly

Done looks like:

- users can answer “what changed in this project?” quickly
- `Briefs` becomes a trustworthy product surface
- we are no longer forcing every session into a review template

### Workstream 3: Dashboard Metrics That Prove Value

Goal:

- surface metrics that make Engrm feel useful instead of busy

Primary repos:

- `candengo-mem`
- `candengo-vector`

Work:

- use synced summary metadata and value signals to power dashboard metrics
- show trendable counts for:
  - bugfixes
  - features
  - decisions
  - discoveries
  - Sentinel findings
- add project-level trend views over time
- add agent/device attribution where it explains value clearly

Done looks like:

- the dashboard shows what Engrm helped produce, not just how much data exists
- trend charts can be trusted because the underlying data is typed cleanly

### Workstream 4: Local SQLite Memory Quality

Goal:

- make the local memory path obviously strong enough that users feel the benefit before thinking about cloud architecture

Primary repo:

- `candengo-mem`

Work:

- continue improving structured fact capture locally
- improve single-hop factual recall locally
- keep startup briefs compact and high-signal
- prefer useful memory objects over generic digests everywhere:
  - capture
  - startup injection
  - search
  - status

Done looks like:

- startup context feels relevant more often
- local recall surfaces facts, decisions, and lessons faster
- local memory remains fast without adding expensive reranking

### Workstream 5: Sentinel As The Safety Net

Goal:

- make Sentinel visibly useful as the practical safety layer around fast-moving AI work

Primary repos:

- `candengo-mem`
- `candengo-vector`

Work:

- expand Sentinel framing from “security preflight” into the vibe-coder safety net
- show advisory outcomes in the dashboard
- track repeated risk themes by project
- prepare plan differentiation:
  - Vibe = advisory
  - Team = blocking and policy

Done looks like:

- users can see what Sentinel prevented
- the safety-net story becomes obvious in both the product and pricing

### Workstream 6: Security And Trust Readiness

Goal:

- be ready when the cloud-memory/privacy objection becomes explicit

Primary repo:

- `candengo-vector`

Work:

- publish a clearer security/trust page
- explain local vs synced data plainly
- document deletion, revocation, and logging posture
- prepare concise answers for proprietary-code and client-work objections

Done looks like:

- security objections have a clear answer path
- we do not need to overclaim compliance to sound credible

## Phase Deliverables

By the end of this phase we should have:

- `Briefs` as the clear primary dashboard memory surface
- OpenClaw brief extraction that reads like useful work, not wrapper noise
- project-level typed metrics and charts
- stronger local SQLite memory quality
- a clearer Sentinel safety-net story
- a cleaner public security/trust posture

## Defer For Later

These should wait until the above is cleaner:

- broad new benchmark pushes beyond targeted spot-checks
- heavier reranking experiments
- more dashboard inference around intent/divergence/regression
- E2EE productization
- more ecosystem/listing work unless it directly helps adoption now

## Proof And Moat

The moat is not "we store vectors".

It is:

- shared memory across devices and agents
- useful local-first recall
- accountability through Delivery Review
- a safety net through Sentinel
- better team memory over time

That is the shape Engrm should keep reinforcing.

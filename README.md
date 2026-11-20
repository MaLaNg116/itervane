# Itervane

An open-source, self-hostable platform for agent-driven application delivery, operations, and governance.

Itervane connects three evidence-based loops:

- Delivery: audit, repair, independently verify, freeze a release candidate, obtain human approval, deploy, and verify the running application.
- Operations: observe, diagnose, propose a bounded action, obtain approval, execute, and verify recovery; code defects enter a linked delivery task.
- Knowledge: turn cases into rule and runbook candidates, validate positive and negative examples, obtain human review, publish a version, and verify reuse in later tasks.

## Status

P0 verification foundations and the independent P1-A/P1-B/P1-C/P1-D1/P1-E control-plane slices are implemented in part. [Blueprint v6](docs/blueprint-v6.md) and the [TypeScript + PostgreSQL implementation plan v2](docs/implementation-plan-v2-ts-postgresql.md) remain the design baseline. Full P0, P1, and the platform MVP have not been accepted as complete.

Available now: strict shared contracts, Anthropic/OpenAI protocol adapters, a bounded tool-loop probe, authenticated local MCP checks, real PostgreSQL transaction/recovery tests, evaluation inputs, and a trusted reference application. The platform capabilities described below remain planned.

The P1-A API adds verified identity, resource registration and durable tasks. P1-B adds a lease-fenced Worker, real PostgreSQL graph interrupts/recovery, a bounded read-only tool gateway, authenticated external MCP task tools, and English/Simplified Chinese messages. Tasks pause at the unavailable Runner gate; submitted code is not executed. See [P1-B setup and boundaries](docs/control-plane-p1-b.md), the [P1-B plan](docs/plans/p1-b-durable-execution-and-mcp.md), and the earlier [P1-A setup](docs/control-plane-p1-a.md). Infrastructure gates remain pending under [ADR 0001](docs/decisions/0001-development-and-runtime-gates.md).

P1-C adds a minimal English/Simplified Chinese React portal with real OIDC Authorization Code + PKCE login, current project permissions, project/repository registration, task history, and versioned retry/cancellation. It uses the same API, database and Worker as MCP. See [portal setup and session boundaries](docs/control-plane-p1-c.md), the [remaining P1 work and P1-C plan](docs/plans/p1-c-portal-and-login.md), and the [review guide](docs/reviews/p1-c-portal-login.md).

P1-D1 adds immutable source-inspection plans, Git object/manifest verification, redacted scanner adapters, and real Gitleaks/Trivy checks on maintainer-generated fixtures. The portal and MCP read the same preparation record. Submitted repositories are not fetched or scanned while the verified disposable-VM gate is closed. See [P1-D setup](docs/control-plane-p1-d.md) and the [D1/D2/D3 implementation and acceptance plan](docs/plans/p1-d-isolated-source-inspection.md).

P1-D2-A adds a maintainer-only libvirt lifecycle probe for a pinned raw guest image. The native KVM run, guest job protocol and isolation evidence are pending. See the [D2-A plan](docs/plans/p1-d2-libvirt-lifecycle.md) and the [review and replay guide](docs/reviews/p1-d2-libvirt-lifecycle.md).

P1-E adds a versioned, read-only bilingual rule/Skill catalogue and bounded text preaudit through the same API, external MCP and portal. Deterministic text checks on synthetic or public snippets and single-file diffs produce persistent, source-free reports with explicit coverage. See [P1-E setup and limits](docs/control-plane-p1-e.md), the [implementation plan](docs/plans/p1-e-rules-and-preaudit.md), and the [review guide](docs/reviews/p1-e-rules-preaudit.md).

P2-A adds a bilingual, bounded ReAct harness and a complete audit, template repair, and independent verification loop for trusted fixtures. The fixture results carry no release eligibility. Delivery tasks in the API and external MCP still wait for a qualified disposable-VM Runner. See [P2-A fixture verification](docs/agent-harness-p2-a.md), the [implementation plan](docs/plans/p2-a-agent-harness.md), and the [review guide](docs/reviews/p2-a-agent-harness.md).

P2-B adds PostgreSQL-backed fixture candidate freezing and bilingual human decision records. Rehearsals cover the exact candidate fingerprint, concurrent decisions, expiration, revocation, and owner reassignment. Fixture confirmations carry no release eligibility. See the [P2-B plan](docs/plans/p2-b-release-candidate.md) and [review guide](docs/reviews/p2-b-release-candidate.md).

P2-C exercises atomic fixture confirmation, operation creation, and queue wakeup. Its ledger serializes reservations by environment and reconciles uncertain outcomes with independent fixture evidence for version, health, and protected access. Live release requires the qualified Runner and verified deployment target. See the [P2-C plan](docs/plans/p2-c-release-reconciliation.md) and [review guide](docs/reviews/p2-c-release-reconciliation.md).

P1-UX refines that portal with a coherent bilingual workspace design and scoped GSAP feedback for actual state changes, new activity and metadata disclosure. Reduced-motion preferences apply live, with immediate permission/error handling. It adds no domain API, migration or execution capability. See [design and motion setup](docs/portal-design-motion.md), the [plan](docs/plans/p1-ux-portal-design-motion.md), and [third-party UI notices](docs/third-party-ui.md).

For P0 setup, observed versions, and outstanding gates, see [P0 verification](docs/p0-verification.md). The repository does not yet deploy applications, execute submitted code, or operate infrastructure through an Agent.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test:integration
pnpm test:portal
pnpm probe:mcp
pnpm probe:evaluation
pnpm probe:agent
pnpm probe:scanners
```

Use Node.js 24 and pnpm 11.9.0. Database tests need Docker with Linux containers, or an explicitly dedicated PostgreSQL 17 test database. Browser tests additionally need the trusted Keycloak image and Chromium (`pnpm --filter @itervane/portal exec playwright install --with-deps chromium` on Linux); Windows uses installed Chrome. Live model and read-only cloud checks are opt-in through an ignored local `.env`. `pnpm verify:p0` reports missing gates as blocked; green unit tests alone cannot pass P0.

The scanner probe needs Git, tar, x64 Windows/Linux and network access to pinned official CLI assets and the official vulnerability database. It accepts no source-path or URL arguments, uses generated inputs only, and does not qualify a production Runner.

## Development baseline

The complete design documents are maintained in Chinese:

- [Baseline index and design consistency](docs/baseline.md): document responsibilities, invariant mapping, approved clarifications, and change records.
- [Blueprint v6](docs/blueprint-v6.md): product vision, all three loops, five logical agent roles, security boundaries, and MVP scope.
- [Implementation plan v2: TypeScript + PostgreSQL](docs/implementation-plan-v2-ts-postgresql.md): technology choices, modules, dependencies, database and concurrency design, P0-P5 tasks, and acceptance criteria.
- [Development plan v1](docs/development-plan-v1.md): actionable P0/P1 tasks, dependencies, and the route to all three MVP loops.
- [P0 verification](docs/p0-verification.md): reproducible checks, current evidence, candidate dependencies, and blockers.
- [Delivery and review index](docs/reviews/README.md): per-delivery code walkthroughs, evidence, limitations, and review order.
- [P1-A control plane](docs/control-plane-p1-a.md): identity, least-privilege database setup, API commands, and verification limits.
- [P1-B durable runtime and MCP](docs/control-plane-p1-b.md): worker startup, checkpoint publication, cancellation/resume, MCP auth, and localization.
- [P1-C portal and login](docs/control-plane-p1-c.md): trusted same-origin build, public OIDC client, memory-only tokens, bilingual workflows, and real browser verification.
- [P1-D1 source-inspection foundations](docs/control-plane-p1-d.md): immutable preparation, content verification, real trusted scanner checks, and the remaining KVM acceptance gates.
- [P1-E rules and text preaudit](docs/control-plane-p1-e.md): advisory rules/Skill, finite non-executing text checks, immutable redacted reports, current project authorization, and the P2-A/P4 boundaries.
- [P2-A Agent harness](docs/agent-harness-p2-a.md) covers fixture runs, bilingual tool decisions, and checkpoint recovery boundaries.
- [P1-UX portal design and motion](docs/portal-design-motion.md): shared design tokens, bounded GSAP feedback, live reduced-motion support, stable session boundaries, and build notices.
- [Portal component migration](docs/portal-shadcn.md): shadcn/ui source ownership, bilingual page and form review, and self-hosted upgrade instructions.

Blueprint v6 remains the product and architecture baseline. The implementation plan records the agreed TypeScript stack and execution approach. No implementation phase has been accepted as complete. Commits are separated by requirement for review.

## Agent engineering

A durable governance workflow surrounds bounded autonomous tool-use loops. Five logical roles cover audit, repair, verification, operations, and rule extraction. Context, budgets, stop conditions, evidence, human intervention, and recovery are explicit platform responsibilities.

MCP works in both directions: external coding assistants connect to the platform, and the platform connects to controlled operations tools.

## Architecture direction

- TypeScript and Node.js for the control plane, workers, agent harness, and MCP integrations.
- React for the portal.
- PostgreSQL for domain records, pg-boss scheduling, and durable agent checkpoints, with separate schemas and migration ownership.
- Drizzle and node-postgres for domain data access; LangGraph TS for agent execution foundations.
- Komodo as the first deployment backend and Whiskers as the first operations MCP integration target.
- Disposable virtual machines for untrusted code execution, testing, and builds.

The platform owns project authorization, release evidence, approvals, operation records, concurrency coordination, and result reconciliation. Agents cannot approve their own deployments or infrastructure actions.

## Initial MVP

One maintainer, one workspace, and one active business workflow. A registered Git snapshot of a standard React/Vite + Node.js/Express application produces one image using mock or public data. Deployment and impactful operations require human confirmation.

The MVP includes all three loops, both MCP directions, and validated reuse of at least one code rule and one runbook. Production data writes, business database migrations, arbitrary host administration, public SaaS multitenancy, and high availability are outside the first release.

## License

Apache License 2.0. See [LICENSE](LICENSE). Third-party components, model services, and rule packages retain their own licenses and terms.


# Itervane

An open-source, self-hostable platform for agent-driven application delivery, operations, and governance.

Itervane connects three evidence-based loops:

- Delivery: audit, repair, independently verify, freeze a release candidate, obtain human approval, deploy, and verify the running application.
- Operations: observe, diagnose, propose a bounded action, obtain approval, execute, and verify recovery; code defects enter a linked delivery task.
- Knowledge: turn cases into rule and runbook candidates, validate positive and negative examples, obtain human review, publish a version, and verify reuse in later tasks.

## Status

P0 verification foundations and the independent P1-A/P1-B control-plane slices are implemented in part. [Blueprint v6](docs/blueprint-v6.md) and the [TypeScript + PostgreSQL implementation plan v2](docs/implementation-plan-v2-ts-postgresql.md) remain the design baseline. Full P0, P1, and the platform MVP have not been accepted as complete.

Available now: strict shared contracts, Anthropic/OpenAI protocol adapters, a bounded tool-loop probe, authenticated local MCP checks, real PostgreSQL transaction/recovery tests, evaluation inputs, and a trusted reference application. The platform capabilities described below remain planned.

The P1-A API adds verified identity, resource registration and durable tasks. P1-B adds a lease-fenced Worker, real PostgreSQL graph interrupts/recovery, a bounded read-only tool gateway, authenticated external MCP task tools, and English/Simplified Chinese messages. Tasks pause at the unavailable Runner gate; submitted code is not executed. See [P1-B setup and boundaries](docs/control-plane-p1-b.md), the [P1-B plan](docs/plans/p1-b-durable-execution-and-mcp.md), and the earlier [P1-A setup](docs/control-plane-p1-a.md). Infrastructure gates remain pending under [ADR 0001](docs/decisions/0001-development-and-runtime-gates.md).

For P0 setup, observed versions, and outstanding gates, see [P0 verification](docs/p0-verification.md). The repository does not yet deploy applications, execute submitted code, or operate infrastructure through an Agent.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test:integration
pnpm probe:mcp
pnpm probe:evaluation
```

Use Node.js 24 and pnpm 11.9.0. Database tests need Docker with Linux containers, or an explicitly dedicated PostgreSQL 17 test database. Live model and read-only cloud checks are opt-in through an ignored local `.env`. `pnpm verify:p0` reports missing gates as blocked; green unit tests alone cannot pass P0.

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


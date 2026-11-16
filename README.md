# Loopstead

An open-source, self-hostable platform for agent-driven application delivery, operations, and governance.

Loopstead connects three evidence-based loops:

- Delivery: audit, repair, independently verify, freeze a release candidate, obtain human approval, deploy, and verify the running application.
- Operations: observe, diagnose, propose a bounded action, obtain approval, execute, and verify recovery; code defects enter a linked delivery task.
- Knowledge: turn cases into rule and runbook candidates, validate positive and negative examples, obtain human review, publish a version, and verify reuse in later tasks.

## Status

Planning stage. [Blueprint v6](docs/blueprint-v6.md) and the [TypeScript + PostgreSQL implementation plan v2](docs/implementation-plan-v2-ts-postgresql.md) define the design baseline. Application implementation has not started.

The capabilities below are planned, not available features.

## Development baseline

The complete design documents are maintained in Chinese:

- [Baseline index and design consistency](docs/baseline.md): document responsibilities, invariant mapping, approved clarifications, and change records.
- [Blueprint v6](docs/blueprint-v6.md): product vision, all three loops, five logical agent roles, security boundaries, and MVP scope.
- [Implementation plan v2: TypeScript + PostgreSQL](docs/implementation-plan-v2-ts-postgresql.md): technology choices, modules, dependencies, database and concurrency design, P0-P5 tasks, and acceptance criteria.

Blueprint v6 remains the product and architecture baseline. The implementation plan records the agreed TypeScript stack and execution approach. No implementation phase has been completed.

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


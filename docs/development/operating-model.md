# Madhusudan demo delivery team

This is the working delivery structure for Maple's Madhusudan voice-agent demo. Roles are assignments for work, not claims that permanent autonomous employees or background jobs exist.

## Decision and delivery structure

| Role | Owner / default model | Accountability |
|---|---|---|
| Product owner | Aditya | Client priorities, real business policy, demo date and acceptance |
| Delivery and product lead | Terra | Scope, caller journeys, dependencies, acceptance scenarios and release readiness |
| Voice engineer | Terra | LiveKit worker, speech providers, interruptions and call lifecycle |
| Backend engineer | Terra | Contracts, durable records, tools, caller context and callback jobs |
| Frontend engineer | Terra | Caller experience, staff desk, transcript, handoff and demo presentation |
| Architecture and QA reviewer | Sol; independent Terra for bounded reviews | Contract consistency, failure cases, implementation review and evidence |
| Operations and documentation | Luna when available | Task status, runbooks, release records and documentation |
| Release coordinator | Session coordinator with Aditya's release decisions | Feature integration and recorded promotion/deployment steps |

Use models below Astra for development. Start with a small active team: product planning and tooling can run independently; backend contracts precede dependent voice/frontend changes. Additional roles are activated when their tasks are ready, not all at once. Runtime concurrency limits determine how many agents can work simultaneously.

## Development cycle

1. Delivery lead writes a task with acceptance cases and dependencies.
2. An implementer claims it, records actual agent/model and creates an isolated feature worktree.
3. The implementer makes a focused change and runs meaningful local checks.
4. A different agent reviews it. The implementer resolves findings.
5. Push the feature branch and open a PR into `develop` with evidence and known limitations.
6. Merge after the agreed checks/review pass. Record the integrated commit separately from deployment.
7. Deploy a reviewed `develop` revision to the dedicated demo environment when that environment is ready; perform real smoke checks and record the result.

The first delivery milestone is the browser voice experience with persistent records and working human takeover. Exotel carrier validation is a separate gate. Distinct caller journeys are part of the demo milestone rather than a later cosmetic addition.

## Task register

The delivery board is the operational register. Technical specifications remain versioned in the repository. If the board is private, its URL belongs in private session/project notes, not public source files. GitHub issues may be used only for sanitized work or when public visibility is accepted.

Required fields: Task ID, Parent ID, Title, Priority, Status, Role, Assigned model, Active agent, Last worked by, Dependencies, Subtasks, Acceptance evidence, Branch, PR, Blocker, Updated at. Never use GitHub's human assignee field to imply a model is a real GitHub user.

| State | Meaning |
|---|---|
| Backlog | Defined future work; not yet ready |
| Ready | Dependencies and required decisions satisfied |
| In progress | A named agent is currently working |
| Review | Implementation exists and is awaiting independent checks |
| Blocked | A named external dependency or required decision prevents completion |
| Done | Task acceptance is met and evidence is linked; integration/deployment status is stated separately |

Subtasks should produce testable results. Examples: caller identity contract, complaint field validation, transcript persistence, duplicate-ticket test, staff takeover failure test. A checklist of files to edit is insufficient acceptance evidence.

## Branch and environment model

| Branch | Purpose | Promotion rule |
|---|---|---|
| `codex/<feature-name>` | One coherent feature or setup change | Focused reviewed PR into develop |
| `develop` | Demo integration | Deploy only to an explicitly configured demo target |
| `staging` | Later release validation | Promote a known develop commit through a release task |
| `prod` | Later production release | Promote a validated staging revision through a release task |
| `main` | Existing repository branch | Remains unchanged during this demo setup |

Branch existence is not proof of an environment. Before deployment, record the target URL/host, database isolation, provider credentials, eligible test recipients, smoke procedure and rollback route in private operations configuration. Do not enable deployment from every feature push.

## Quality and delivery gates

- Local: supported Node/pnpm, frozen dependencies, relevant tests, typecheck and build; Python checks when the voice package exists.
- CI: GitHub Actions must actually start and pass; an account-level service block is a release dependency, not a reason to suppress checks.
- Review: independent code/spec review with evidence from the exact commit.
- Demo: all selected caller journeys complete their stated actions; fixtures and live data are visibly distinguished.
- Telephone: a real inbound/outbound carrier test verifies answer and two-way audio; browser success alone is insufficient.
- Handoff: confirmed human connection, AI silence and tested failure handling.
- Release: exact commit, target environment, migration result, smoke result and rollback reference are recorded.

Maintain short commits under Aditya's verified Git identity. Push completed feature increments; preserve visible blockers instead of presenting unfinished work as shipped.

## Initial role assignments

The first setup workstreams are product/demo planning and development tooling, both assigned to Terra. The delivery register records their actual agent names and current status. Sol/Luna roles are used when an execution slot is available; they are not represented as active merely because this document names them.

Demo date, board location/visibility and the final Git email are user preferences to confirm when supplied. Until then, use the existing verified repository email, keep the operational board private, and avoid invented delivery dates.

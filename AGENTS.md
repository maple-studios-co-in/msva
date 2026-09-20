# MSVA delivery rules

## Product scope

Build the Madhusudan demo in this repository. Keep the existing React/TypeScript application, Node business API and PostgreSQL database; isolate the new LiveKit voice worker. Demo priorities include distinct consumer, retailer, distributor and sales-prospect journeys, returning-caller continuity, structured complaints, human handoff and tracked callbacks. Voice cloning is a later release.

## Ownership and models

- Aditya is the product owner and decides business policy, demo acceptance and environment promotion.
- Use `gpt-5.6-terra` for product planning and frontend, backend and voice implementation.
- Use `gpt-5.6-sol` for complex architecture and independent review when available. Terra may cross-review a bounded change it did not implement.
- Use `gpt-5.6-luna` for mechanical documentation, task updates and release administration when available.
- Do not assign development to Astra unless Aditya explicitly changes this instruction. Coordination does not change a worker's model.
- Record the actual active agent and model, not only a planned role. Queued assignments are not running agents.

## Task ownership

Every task must have a stable ID, parent or epic, owner role, model, status, dependencies, subtasks, acceptance evidence, feature branch and PR link. Allowed states: Backlog, Ready, In progress, Review, Blocked, Done.

Claim a task before editing. Use one isolated writable worktree per feature branch and a defined file scope. Do not concurrently edit another agent's files. Independent tasks may run in parallel; shared contracts and migrations are coordinated first. Respect the active worker limit reported by the execution environment.

Update the task register when work starts, blocks, enters review or completes. Clear active-agent ownership when the agent stops. Preserve a last-worked-by field for history. A finished turn does not mean agents will keep working in the background.

## Branches and releases

- Start feature work from `develop` using `codex/<feature-name>` unless Aditya supplies another name.
- Open a focused PR into `develop`; preserve independent feature history and push completed increments.
- `develop` is the demo integration branch. A merge is not a deployment.
- Do not point a develop deployment at the current production environment. A separate demo target, credentials and deployment checks must exist first.
- Create/promote `staging` and `prod` only in a later release task. Leave existing `main` unchanged during demo setup.
- Do not force-push shared branches, rewrite other authors' commits or merge unreviewed application changes.

## Commit identity

Use the verified repository identity for both author and committer: name `Aditya Agrawal` or an explicitly approved Maple identity, with the already verified email. Do not invent an email, change global Git identity, or add bot/AI coauthor trailers.

Keep commit subjects short and imperative, preferably at most 60 characters. Each commit should describe one coherent change. Examples: `Add caller journey contracts`, `Handle failed call takeover`, `Set up demo checks`.

## Verification

Run the local environment preflight, relevant tests, typecheck and build for the touched components. Validate database migrations against test data. Tests must not place real calls, send messages or perform real customer actions by default.

Obtain review from an agent that did not implement the change. Do not report a failing or unstarted GitHub check as passed. A CI account/service block stays visible on the task and release record. Do not install a public-PR self-hosted runner to bypass it.

Label seeded/demo data and disconnected integrations explicitly. A browser call, health check or simulation does not prove a telephone call works. A ticket is not a completed callback or human transfer. SOS suggestions are separate from sentiment and require tested staff escalation.

## Repository and data handling

This repository is public. Commit technical specifications and sanitized fixtures only. Keep credentials, customer records/audio, private delivery-board links, account contacts and detailed internal incident findings outside the repository. Never stage unrelated untracked files or environment files.

Record deployment and external integration changes separately from code delivery. Do not contact third parties, dial recipients or send client messages unless the session explicitly authorizes those actions.

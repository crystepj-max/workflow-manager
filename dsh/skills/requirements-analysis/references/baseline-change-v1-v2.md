# Requirement baseline V1 to V2

Use this flow when an accepted Multica Task changes in a way that affects its goal, scope, user behavior, business rules, acceptance, risk, or independently testable slices. Wording fixes that do not change meaning do not require a new baseline.

## Steps

1. Read the current Multica Task, definition metadata, dependencies, specification, and active Run state.
2. If a Run is active, do not change its input silently. Record the conflict and wait for a safe stop or explicit owner decision.
3. Analyze the change and any new product decisions. Keep the Task in `backlog` while V2 is under review; do not leave a valid V1 definition that M3 could still select.
4. Write `task-spec-V2.md`, update its Definition Check, and confirm there are no unresolved product decisions.
5. Present V2 to the user. Do not update the authoritative Task until the user confirms this baseline.
6. After confirmation, update the Multica Task description and `dev-flow.definition.v1` fields (`baseline_version`, `defined_at`, `spec_ref`, and other changed values). Update `dev-flow.dependencies.v1` when dependency edges change.
7. Read back the Task and both metadata keys. If they match the confirmed V2, restore `todo` with `--no-start`; otherwise leave it blocked from unattended planning and report the discrepancy.

Keep `defined_at` as the V2 baseline confirmation time. Preserve the V1 specification and version history. Never edit an already-started Run's baseline in place.

## Confirmation request

```text
请确认需求基线 V2。主要变化：
- <变化 1>
- <变化 2>

规格：docs/tasks/specs/<slug>/task-spec-V2.md
Definition Check：通过 / 未通过（未决事项数）
```

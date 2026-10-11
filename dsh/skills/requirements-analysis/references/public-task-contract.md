# Multica Task definition contract

This contract defines the handoff from requirements analysis to dev-flow. Multica owns Task identity, work status, definition metadata, dependencies, and run history. A repository-local specification stores detailed requirement content; it is not a second status ledger.

## Human decisions and completion

- A task is not ready for unattended execution until the user confirms its requirement baseline, every Definition Check item passes, and `pending_product_decisions` is `0`.
- The unattended permission is an explicit product decision. Never infer permission from an assignee, project status, or user request to analyze requirements.
- `backlog` and `todo` are Multica work statuses. Requirement-definition status is separate and belongs to `dev-flow.definition.v1.definition_status`.
- When the baseline is not confirmed, keep the Task in `backlog` and do not write a valid defined carrier. After confirmation and successful metadata readback, move it to `todo` with `--no-start`.
- A failure to create, update, read back, or set the Task status means the registration is incomplete. Do not substitute a local file, registry, or board as the authoritative state.

## Multica Task fields

The Multica Task UUID is the only task identifier. Preserve source tracker IDs as links in the Task description; they do not replace the Multica UUID.

The Task description or attached repository specification must state:

- Goal, scope, non-goals, user-visible behavior, and acceptance conditions.
- Source links and the target code repository.
- Priority, environment group and role, unattended decision, dependencies, and specification path.
- Version history and the user confirmation for each accepted baseline.

Multica's native priority values are `urgent`, `high`, `medium`, `low`, and `none`. If a source specification uses the project's P0–P2 shorthand, map P0 to `high`, P1 to `medium`, and P2 to `low`. Preserve an explicitly requested `urgent`; when priority is unspecified, omit `--priority` instead of inventing one.

## Versioned metadata

Multica metadata values are strings. Encode each value as a JSON string and set it with `multica issue metadata set <uuid> --key <key> --type string --value '<json>'`.

### `dev-flow.definition.v1`

```json
{
  "definition_status": "defined",
  "baseline_version": "V1",
  "unattended": true,
  "env_group": "<group-id>",
  "env_role": "independent",
  "pending_product_decisions": 0,
  "defined_at": "<RFC3339 timestamp>",
  "spec_ref": "docs/tasks/specs/<slug>/task-spec-V1.md"
}
```

Allowed definition statuses are `defined` and `local_defined`; new registrations use `defined` because Multica is available. `unattended` must be a boolean. `env_role` is `independent` or `member`. `defined_at` records the accepted baseline time. `spec_ref` must be a non-empty repository-relative path whose resolved file stays inside the target repository.

### `dev-flow.dependencies.v1`

The value is a JSON array of Multica Task UUIDs. Always write the key. Use `[]` when there are no dependencies; a missing key is not equivalent to an empty list. Cross-project dependencies are allowed. Each dependency is satisfied only when its Multica work status and category are both `done`.

## Handoff

dev-flow reads candidates and these versioned metadata keys from Multica. A valid definition is not permission to start work by itself: the user-approved scope, Multica Task status, and the execution safety gate still apply. Planning output, simulated batches, and Run status are distinct evidence.

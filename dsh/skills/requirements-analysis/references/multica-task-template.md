# Multica Task definition template

Create or update a Multica Task in the explicitly selected project. The Task UUID returned by Multica is the identifier; do not allocate a local number.

## Task description

```text
Goal:
<observable outcome>

Scope:
<included behavior>

Non-goals:
<excluded behavior>

Acceptance:
<verifiable user outcomes>

Requirement baseline: V<n>
Source:
<source tracker link or conversation summary>
Specification:
<repo-relative spec_ref>
Definition Check: passed; pending product decisions = 0
Unattended permission: explicitly allowed / not allowed
Priority: urgent / high / medium / low / none; omit when unspecified
Environment group / role:
Dependencies:
<Multica Task UUIDs, or none>

Baseline confirmation:
<user, date, and decision reference>
```

## Required metadata

- `dev-flow.definition.v1`: JSON string with the eight fields in `public-task-contract.md`.
- `dev-flow.dependencies.v1`: JSON string containing an array of Multica Task UUIDs; use `[]` when there are none.

Keep the Multica work status at `backlog` until the baseline is explicitly confirmed and both metadata values have been read back successfully. Then set `todo` with `--no-start`.

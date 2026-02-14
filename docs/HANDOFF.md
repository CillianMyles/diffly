# Handoff

Use this file to transfer context between sessions/agents with minimal loss.

## Current State

- Active phase: Phase 2 start (Rust parity work)
- Fixture suite: 18 conformance cases
- Truth sources:
  - vision/roadmap: `README.md`
  - semantics: `diffly-spec/SPEC.md`
  - current progress: `docs/STATUS.md`
  - decisions/constraints: `docs/DECISIONS.md`
- Implemented semantics highlights:
  - `header_mode`: `strict` (default) and `sorted`
  - duplicate column names: hard error
  - missing key values (`""`): hard error
- Rust implementation:
  - `diffly-rust/diffly-core`: semantics engine
  - `diffly-rust/diffly-cli`: native CLI entrypoint
  - `diffly-rust/diffly-conformance`: fixture parity runner

## Quick Resume Checklist

1. `git pull origin main`
2. Read `docs/STATUS.md` and `docs/DECISIONS.md`
3. Run `make test-spec`
4. Run `make test-spec-rust`
5. If touching rules/instructions:
   - edit `.rulesync/rules/general.md`
   - run `make rules-generate`
6. After any change, run relevant validation commands and update `docs/STATUS.md`

## Delivery Rules

- Keep changes small and logical.
- Use Conventional Commits.
- Include commit trailer:
  - `Co-authored-by: Cillian Myles <myles.cillian@gmail.com>`
- Push to `main` (current policy until changed).
- In autonomous mode, continue chunk-by-chunk without waiting for approval between chunks.
- Stop only for hard blockers, uncovered product decisions, or explicit user stop.

## Minimum Validation Before Commit

- `make test-spec`
- `cargo test --manifest-path diffly-rust/Cargo.toml` (when Rust code changes)
- Any targeted command related to changed files (example: CLI smoke run)

## If Blocked

Record in `docs/STATUS.md`:

- what was attempted
- exact blocker/error
- one or two concrete next options

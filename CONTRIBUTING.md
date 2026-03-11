# Contributing

## Prerequisites

- Python 3.12 or newer
- Rust stable via `rustup`
- Node.js 22 (`nvm use` works with the included `.nvmrc`)
- Optional: `wasm-pack` if you need to rebuild `diffly-web/src/wasm/pkg`

## First-time setup

From repo root:

```bash
make doctor
make bootstrap
```

`make doctor` prints the local toolchain versions that `diffly` expects.

## Daily workflow

Run the common checks from repo root:

```bash
make lint
make test
make check
```

Command guide:

- `make lint`: Rust formatting check plus web ESLint
- `make test`: Python fixture/spec checks, Python CLI tests, Rust tests/conformance, and web typecheck
- `make check`: `make lint`, `make test`, and a production web build

## Useful commands

```bash
make diff A=path/to/a.csv B=path/to/b.csv
make diff A=path/to/a.csv B=path/to/b.csv KEY=id
make diff-rust A=path/to/a.csv B=path/to/b.csv
make diff-rust A=path/to/a.csv B=path/to/b.csv KEYS=id,region FORMAT=summary
make web-dev
make wasm-build-web
```

Parameter notes:

- Use `KEY=id` for a single key column in `make diff` / `make diff-rust`
- Use `KEYS=id,region` for composite keys
- `IGNORE_ROW_ORDER=1` is positional-only and should not be combined with `KEY` or `KEYS`
- `IGNORE_COLUMN_ORDER=1` maps to sorted-header comparison

## Repo map

- `diffly-spec/`: semantic spec and fixtures
- `diffly-python/`: Python reference implementation and fixture runner
- `diffly-rust/`: Rust core, engine, CLI, conformance runner, and WASM bindings
- `diffly-web/`: Next.js browser UI
- `docs/`: status, decisions, handoff, and manual validation notes

## Before sending changes

- Update `docs/STATUS.md` when a logical chunk is complete
- Update `docs/DECISIONS.md` if product or semantic behavior changed
- Keep changes small and avoid formatting-only churn

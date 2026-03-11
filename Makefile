# Diffly Makefile

CARGO_ENV = \
	CARGO_BIN="$$(command -v cargo || true)"; \
	RUSTUP_BIN="$$(command -v rustup || true)"; \
	if [ -z "$$RUSTUP_BIN" ] && [ -x "/opt/homebrew/opt/rustup/bin/rustup" ]; then \
		RUSTUP_BIN="/opt/homebrew/opt/rustup/bin/rustup"; \
	fi; \
	if [ -z "$$CARGO_BIN" ] && [ -n "$$RUSTUP_BIN" ]; then \
		CARGO_BIN="$$($$RUSTUP_BIN which cargo 2>/dev/null || true)"; \
	fi; \
	if [ -z "$$CARGO_BIN" ] || [ ! -x "$$CARGO_BIN" ]; then \
		echo "cargo is required (install rustup + stable toolchain first)"; \
		exit 2; \
	fi; \
	export PATH="$$(dirname "$$CARGO_BIN"):$$PATH";

.PHONY: help list doctor bootstrap lint lint-rust-format test test-python test-rust check

help:
	@echo ""
	@echo "Project:"
	@echo "    make doctor                Show local toolchain versions used by the repo"
	@echo "    make bootstrap             Install local web dependencies"
	@echo "    make lint                  Run the available lint/format checks"
	@echo "    make test                  Run the main local validation suite"
	@echo "    make check                 Run lint, tests, typecheck, and production web build"
	@echo "    make test-spec             Run diffly spec fixtures"
	@echo "    make test-python           Run Python CLI regression tests"
	@echo "    make test-spec-rust        Run diffly spec fixtures against Rust core"
	@echo "    make test-spec-rust-engine [PARTITIONS=N]  Run fixtures against Rust engine path (default N=1)"
	@echo "    make diff A=... B=... [KEY=...|KEYS=...] [HEADER_MODE=strict|sorted] [IGNORE_COLUMN_ORDER=1] [IGNORE_ROW_ORDER=1]  Run CSV diff (positional default; keyed when keys provided)"
	@echo "    make diff-rust A=... B=... [KEY=...|KEYS=...] [HEADER_MODE=strict|sorted] [IGNORE_COLUMN_ORDER=1] [IGNORE_ROW_ORDER=1] [EMIT_PROGRESS=1] [PARTITIONS=N] [NO_PARTITIONS=1] [FORMAT=jsonl|json|summary|diff] [OUT=path]  Run Rust CSV diff (positional default; keyed when keys provided)"
	@echo "    make web-install           Install diffly-web dependencies"
	@echo "    make web-lint              Lint diffly-web"
	@echo "    make web-dev               Run diffly-web dev server"
	@echo "    make web-typecheck         Type-check diffly-web"
	@echo "    make web-build             Build diffly-web for production"
	@echo "    make wasm-build-web        Build Rust WASM package into diffly-web"
	@echo ""
	@echo "GenAI Tooling:"
	@echo "    make rules-install         Install GenAI rule tooling"
	@echo "    make rules-generate        Generate AI agent rules files"
	@echo ""

list:
	@grep '^[^#[:space:]].*:' Makefile

doctor:
	@printf 'python3: '; \
	if command -v python3 >/dev/null 2>&1; then python3 --version; else echo "missing"; fi
	@printf 'node:    '; \
	if command -v node >/dev/null 2>&1; then node --version; else echo "missing"; fi
	@printf 'npm:     '; \
	if command -v npm >/dev/null 2>&1; then npm --version; else echo "missing"; fi
	@printf 'cargo:   '; \
	if command -v cargo >/dev/null 2>&1; then cargo --version; else echo "missing"; fi
	@printf 'rustup:  '; \
	if command -v rustup >/dev/null 2>&1; then rustup --version | head -n 1; else echo "missing"; fi
	@printf 'wasm-pack (optional): '; \
	if command -v wasm-pack >/dev/null 2>&1; then wasm-pack --version; else echo "missing"; fi

bootstrap: web-install

lint: lint-rust-format web-lint

lint-rust-format:
	@$(CARGO_ENV) \
	"$$CARGO_BIN" fmt --manifest-path diffly-rust/Cargo.toml --all --check

test: test-spec test-python test-rust test-spec-rust test-spec-rust-engine web-typecheck

test-python:
	python3 -m unittest discover -s diffly-python/tests -p 'test_*.py'

test-rust:
	@$(CARGO_ENV) \
	"$$CARGO_BIN" test --manifest-path diffly-rust/Cargo.toml

check: lint test web-build

test-spec:
	python3 diffly-python/run_spec.py

test-spec-rust:
	@$(CARGO_ENV) \
	"$$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-conformance

test-spec-rust-engine:
	@$(CARGO_ENV) \
	DIFFLY_ENGINE_PARTITIONS="$${PARTITIONS:-1}" \
	"$$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-conformance

diff:
	@if [ -z "$(A)" ] || [ -z "$(B)" ]; then \
		echo "Usage: make diff A=path/to/a.csv B=path/to/b.csv [KEY=id|KEYS=id,region] [HEADER_MODE=strict|sorted] [IGNORE_COLUMN_ORDER=1] [IGNORE_ROW_ORDER=1]"; \
		exit 2; \
	fi; \
	if [ -n "$(KEY)" ] && [ -n "$(KEYS)" ]; then \
		echo "Provide either KEY=... or KEYS=..., not both"; \
		exit 2; \
	fi; \
	if [ -n "$(IGNORE_ROW_ORDER)" ] && { [ -n "$(KEY)" ] || [ -n "$(KEYS)" ]; }; then \
		echo "IGNORE_ROW_ORDER=1 cannot be combined with KEY or KEYS"; \
		exit 2; \
	fi; \
	KEY_ARGS=""; \
	if [ -n "$(KEY)" ]; then \
		KEY_ARGS="$$KEY_ARGS --key $(KEY)"; \
	fi; \
	if [ -n "$(KEYS)" ]; then \
		KEYS_SPLIT="$$(printf '%s' "$(KEYS)" | tr ',' ' ')"; \
		for key in $$KEYS_SPLIT; do \
			trimmed="$$(printf '%s' "$$key" | sed 's/^ *//;s/ *$$//')"; \
			if [ -n "$$trimmed" ]; then \
				KEY_ARGS="$$KEY_ARGS --key $$trimmed"; \
			fi; \
		done; \
	fi; \
	IGNORE_COLUMN_ORDER_ARG=""; \
	if [ -n "$(IGNORE_COLUMN_ORDER)" ]; then \
		IGNORE_COLUMN_ORDER_ARG="--ignore-column-order"; \
	fi; \
	IGNORE_ROW_ORDER_ARG=""; \
	if [ -n "$(IGNORE_ROW_ORDER)" ]; then \
		IGNORE_ROW_ORDER_ARG="--ignore-row-order"; \
	fi; \
	python3 diffly-python/diffly.py --a "$(A)" --b "$(B)" $$KEY_ARGS --header-mode "$${HEADER_MODE:-strict}" $$IGNORE_COLUMN_ORDER_ARG $$IGNORE_ROW_ORDER_ARG

diff-rust:
	@if [ -z "$(A)" ] || [ -z "$(B)" ]; then \
		echo "Usage: make diff-rust A=path/to/a.csv B=path/to/b.csv [KEY=id|KEYS=id,region] [HEADER_MODE=strict|sorted] [IGNORE_COLUMN_ORDER=1] [IGNORE_ROW_ORDER=1]"; \
		exit 2; \
	fi; \
	if [ -n "$(KEY)" ] && [ -n "$(KEYS)" ]; then \
		echo "Provide either KEY=... or KEYS=..., not both"; \
		exit 2; \
	fi; \
	if [ -n "$(IGNORE_ROW_ORDER)" ] && { [ -n "$(KEY)" ] || [ -n "$(KEYS)" ]; }; then \
		echo "IGNORE_ROW_ORDER=1 cannot be combined with KEY or KEYS"; \
		exit 2; \
	fi; \
	KEY_ARGS=""; \
	if [ -n "$(KEY)" ]; then \
		KEY_ARGS="$$KEY_ARGS --key $(KEY)"; \
	fi; \
	if [ -n "$(KEYS)" ]; then \
		KEYS_SPLIT="$$(printf '%s' "$(KEYS)" | tr ',' ' ')"; \
		for key in $$KEYS_SPLIT; do \
			trimmed="$$(printf '%s' "$$key" | sed 's/^ *//;s/ *$$//')"; \
			if [ -n "$$trimmed" ]; then \
				KEY_ARGS="$$KEY_ARGS --key $$trimmed"; \
			fi; \
		done; \
	fi; \
	PROGRESS_ARG=""; \
	if [ -n "$(EMIT_PROGRESS)" ]; then \
		PROGRESS_ARG="--emit-progress"; \
	fi; \
	PARTITION_ARG=""; \
	if [ -n "$(PARTITIONS)" ]; then \
		PARTITION_ARG="--partitions $(PARTITIONS)"; \
	fi; \
	NO_PARTITIONS_ARG=""; \
	if [ -n "$(NO_PARTITIONS)" ]; then \
		NO_PARTITIONS_ARG="--no-partitions"; \
	fi; \
	FORMAT_ARG=""; \
	if [ -n "$(FORMAT)" ]; then \
		FORMAT_ARG="--format $(FORMAT)"; \
	fi; \
	OUT_ARG=""; \
	if [ -n "$(OUT)" ]; then \
		OUT_ARG="--out $(OUT)"; \
	fi; \
	IGNORE_COLUMN_ORDER_ARG=""; \
	if [ -n "$(IGNORE_COLUMN_ORDER)" ]; then \
		IGNORE_COLUMN_ORDER_ARG="--ignore-column-order"; \
	fi; \
	IGNORE_ROW_ORDER_ARG=""; \
	if [ -n "$(IGNORE_ROW_ORDER)" ]; then \
		IGNORE_ROW_ORDER_ARG="--ignore-row-order"; \
	fi; \
	$(CARGO_ENV) \
	"$$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-cli -- --a "$(A)" --b "$(B)" $$KEY_ARGS --header-mode "$${HEADER_MODE:-strict}" $$IGNORE_COLUMN_ORDER_ARG $$IGNORE_ROW_ORDER_ARG $$PROGRESS_ARG $$PARTITION_ARG $$NO_PARTITIONS_ARG $$FORMAT_ARG $$OUT_ARG

web-install:
	npm --prefix diffly-web install

web-lint:
	npm --prefix diffly-web run lint

web-build:
	npm --prefix diffly-web run build

web-dev:
	npm --prefix diffly-web run dev

web-typecheck:
	npm --prefix diffly-web run typecheck

wasm-build-web:
	@WASM_PACK_BIN="$$(command -v wasm-pack || true)"; \
	$(CARGO_ENV) \
	if [ -z "$$WASM_PACK_BIN" ] && [ -x "$$HOME/.cargo/bin/wasm-pack" ]; then \
		WASM_PACK_BIN="$$HOME/.cargo/bin/wasm-pack"; \
	fi; \
	if [ -z "$$WASM_PACK_BIN" ]; then \
		echo "wasm-pack is required (install: cargo install wasm-pack)"; \
		exit 2; \
	fi; \
	"$$WASM_PACK_BIN" build diffly-rust/diffly-wasm --target web --out-dir ../../diffly-web/src/wasm/pkg --out-name diffly_wasm; \
	printf '%s\n' '*' '!diffly_wasm.js' '!diffly_wasm.d.ts' '!diffly_wasm_bg.wasm' '!diffly_wasm_bg.wasm.d.ts' '!package.json' '!.gitignore' > diffly-web/src/wasm/pkg/.gitignore

# GenAI Tooling - Source: .rulesync/**
.PHONY: rules-install rules-generate

rules-install:
	brew install rulesync

rules-generate:
	rulesync generate --delete -f rules -t agentsmd,agentskills,claudecode,cursor,codexcli,opencode

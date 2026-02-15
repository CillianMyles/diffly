# Diffly Makefile

.PHONY: help list

help:
	@echo ""
	@echo "Project:"
	@echo "    make test-spec             Run diffly spec fixtures"
	@echo "    make test-spec-rust        Run diffly spec fixtures against Rust core"
	@echo "    make test-spec-rust-engine [PARTITIONS=N]  Run fixtures against Rust engine path (default N=1)"
	@echo "    make diff A=... B=... KEY=...|KEYS=... [HEADER_MODE=strict|sorted]  Run keyed CSV diff"
	@echo "    make diff-rust A=... B=... KEY=...|KEYS=... [HEADER_MODE=strict|sorted] [EMIT_PROGRESS=1] [PARTITIONS=N] [NO_PARTITIONS=1]  Run Rust keyed CSV diff"
	@echo "    make web-install           Install diffly-web dependencies"
	@echo "    make web-dev               Run diffly-web dev server"
	@echo "    make web-typecheck         Type-check diffly-web"
	@echo "    make wasm-build-web        Build Rust WASM package into diffly-web"
	@echo ""
	@echo "GenAI Tooling:"
	@echo "    make rules-install         Install GenAI rule tooling"
	@echo "    make rules-generate        Generate AI agent rules files"
	@echo ""

list:
	@grep '^[^#[:space:]].*:' Makefile

.PHONY: test-spec

test-spec:
	python3 diffly-python/run_spec.py

.PHONY: test-spec-rust

test-spec-rust:
	@CARGO_BIN="$$(command -v cargo || true)"; \
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
	export PATH="$$(dirname "$$CARGO_BIN"):$$PATH"; \
	"$$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-conformance

.PHONY: test-spec-rust-engine

test-spec-rust-engine:
	@CARGO_BIN="$$(command -v cargo || true)"; \
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
	export PATH="$$(dirname "$$CARGO_BIN"):$$PATH"; \
	DIFFLY_ENGINE_PARTITIONS="$${PARTITIONS:-1}" \
	"$$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-conformance

.PHONY: diff

diff:
	@if [ -z "$(A)" ] || [ -z "$(B)" ]; then \
		echo "Usage: make diff A=path/to/a.csv B=path/to/b.csv KEY=id [HEADER_MODE=strict|sorted]"; \
		echo "   or: make diff A=path/to/a.csv B=path/to/b.csv KEYS=id,region [HEADER_MODE=strict|sorted]"; \
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
	if [ -z "$$KEY_ARGS" ]; then \
		echo "At least one key is required: KEY=id or KEYS=id,region"; \
		exit 2; \
	fi; \
	python3 diffly-python/diffly.py --a "$(A)" --b "$(B)" $$KEY_ARGS --header-mode "$${HEADER_MODE:-strict}"

.PHONY: diff-rust

diff-rust:
	@if [ -z "$(A)" ] || [ -z "$(B)" ]; then \
		echo "Usage: make diff-rust A=path/to/a.csv B=path/to/b.csv KEY=id [HEADER_MODE=strict|sorted]"; \
		echo "     or make diff-rust A=path/to/a.csv B=path/to/b.csv KEYS=id,region [HEADER_MODE=strict|sorted]"; \
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
	if [ -z "$$KEY_ARGS" ]; then \
		echo "At least one key is required: KEY=id or KEYS=id,region"; \
		exit 2; \
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
	export PATH="$$(dirname "$$CARGO_BIN"):$$PATH"; \
	"$$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-cli -- --a "$(A)" --b "$(B)" $$KEY_ARGS --header-mode "$${HEADER_MODE:-strict}" $$PROGRESS_ARG $$PARTITION_ARG $$NO_PARTITIONS_ARG

.PHONY: web-install web-dev web-typecheck wasm-build-web

web-install:
	npm --prefix diffly-web install

web-dev:
	npm --prefix diffly-web run dev

web-typecheck:
	npm --prefix diffly-web run typecheck

wasm-build-web:
	@WASM_PACK_BIN="$$(command -v wasm-pack || true)"; \
	CARGO_BIN="$$(command -v cargo || true)"; \
	RUSTUP_BIN="$$(command -v rustup || true)"; \
	if [ -z "$$RUSTUP_BIN" ] && [ -x "/opt/homebrew/opt/rustup/bin/rustup" ]; then \
		RUSTUP_BIN="/opt/homebrew/opt/rustup/bin/rustup"; \
	fi; \
	if [ -z "$$CARGO_BIN" ] && [ -n "$$RUSTUP_BIN" ]; then \
		CARGO_BIN="$$($$RUSTUP_BIN which cargo 2>/dev/null || true)"; \
	fi; \
	if [ -z "$$WASM_PACK_BIN" ] && [ -x "$$HOME/.cargo/bin/wasm-pack" ]; then \
		WASM_PACK_BIN="$$HOME/.cargo/bin/wasm-pack"; \
	fi; \
	if [ -z "$$WASM_PACK_BIN" ]; then \
		echo "wasm-pack is required (install: cargo install wasm-pack)"; \
		exit 2; \
	fi; \
	if [ -n "$$CARGO_BIN" ]; then \
		export PATH="$$(dirname "$$CARGO_BIN"):$$PATH"; \
	fi; \
	"$$WASM_PACK_BIN" build diffly-rust/diffly-wasm --target web --out-dir ../../diffly-web/src/wasm/pkg --out-name diffly_wasm; \
	printf '%s\n' '*' '!diffly_wasm.js' '!diffly_wasm.d.ts' '!diffly_wasm_bg.wasm' '!diffly_wasm_bg.wasm.d.ts' '!package.json' '!.gitignore' > diffly-web/src/wasm/pkg/.gitignore

# GenAI Tooling - Source: .rulesync/**
.PHONY: rules-install rules-generate

rules-install:
	brew install rulesync

rules-generate:
	rulesync generate -f rules -t agentsmd,claudecode,cursor,codexcli,opencode,copilot

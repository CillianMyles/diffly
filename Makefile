# Diffly Makefile

.PHONY: help list

help:
	@echo ""
	@echo "Project:"
	@echo "    make test-spec             Run diffly spec fixtures"
	@echo "    make test-spec-rust        Run diffly spec fixtures against Rust core"
	@echo "    make diff A=... B=... KEY=...|KEYS=... [HEADER_MODE=strict|sorted]  Run keyed CSV diff"
	@echo "    make diff-rust A=... B=... KEY=...|KEYS=... [HEADER_MODE=strict|sorted]  Run Rust keyed CSV diff"
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
	"$$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-cli -- --a "$(A)" --b "$(B)" $$KEY_ARGS --header-mode "$${HEADER_MODE:-strict}"

# GenAI Tooling - Source: .rulesync/**
.PHONY: rules-install rules-generate

rules-install:
	brew install rulesync

rules-generate:
	rulesync generate -f rules -t agentsmd,claudecode,cursor,codexcli,opencode,copilot

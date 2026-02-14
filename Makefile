# Diffly Makefile

.PHONY: help list

help:
	@echo ""
	@echo "Project:"
	@echo "    make test-spec             Run diffly spec fixtures"
	@echo "    make test-spec-rust        Run diffly spec fixtures against Rust core"
	@echo "    make diff A=... B=... KEY=... [HEADER_MODE=strict|sorted]  Run keyed CSV diff"
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
	@if ! command -v cargo >/dev/null 2>&1; then \
		echo "cargo is required (install rustup + stable toolchain first)"; \
		exit 2; \
	fi
	cargo run --manifest-path diffly-rust/Cargo.toml -p diffly-conformance

.PHONY: diff

diff:
	@if [ -z "$(A)" ] || [ -z "$(B)" ] || [ -z "$(KEY)" ]; then \
		echo "Usage: make diff A=path/to/a.csv B=path/to/b.csv KEY=id"; \
		exit 2; \
	fi
	python3 diffly-python/diffly.py --a "$(A)" --b "$(B)" --key "$(KEY)" --header-mode "$${HEADER_MODE:-strict}"

# GenAI Tooling - Source: .rulesync/**
.PHONY: rules-install rules-generate

rules-install:
	brew install rulesync

rules-generate:
	rulesync generate -f rules -t agentsmd,claudecode,cursor,codexcli,opencode,copilot

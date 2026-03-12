# Publishing Plan

**TL;DR:** Treat the Rust CLI as a native binary product first. Publish prebuilt release artifacts as the primary distribution path, then layer on package-manager channels where they improve install UX without becoming the source of truth.

## Goal

Ship the Rust CLI in a way that is:

- easy to install for non-Rust users
- stable across macOS, Linux, and Windows
- compatible with the current workspace layout
- low-maintenance for a small project

## Current Constraints

- The CLI crate is currently named `diffly-cli`, not `diffly`.
- The CLI depends on unpublished workspace crates via local `path` dependencies.
- The repository has CI coverage for build/test/smoke validation, but no tag-based CLI release pipeline yet.
- The web app already has a deployment path, so CLI distribution should stay operationally separate from web hosting.

## Recommendation

### Primary distribution

Use GitHub Releases with prebuilt binaries as the canonical distribution channel.

Why:

- no local Rust toolchain required for end users
- cross-platform binaries are the normal expectation for native CLIs
- release assets can also feed Homebrew, npm wrapper installs, and other package-manager channels
- this matches the product shape: `diffly` is fundamentally a Rust-native CLI, not a Node-first tool

### Secondary distribution

Add Homebrew after GitHub Releases are working.

Why:

- strong fit for macOS developer workflows
- low friction for the likely early adopter audience
- can consume release tarballs rather than requiring custom build logic on user machines

### Optional Rust-native channel

Add `cargo install` only after the workspace is publishable to crates.io.

Why:

- useful for Rust users
- currently blocked by unpublished local-path internal crates
- source builds are slower and less reliable for general users than prebuilt binaries

Prefer supporting `cargo-binstall` once release artifacts exist, so Rust users can install fast binaries instead of compiling from source.

### Optional JavaScript channel

Add npm only as a wrapper over the prebuilt native binaries.

Why:

- good if you want `npx diffly` or adoption from Node-heavy users
- not a good primary strategy for a Rust-native CLI
- should avoid compiling Rust during `npm install`

The npm package should download the correct release artifact for the host platform and expose a `diffly` command via the package `bin` field.

## What Not To Do First

- Do not make npm the canonical release path.
- Do not require Rust compilation during npm install.
- Do not publish to crates.io before deciding whether internal crates are meant to be public and versioned.
- Do not couple CLI releases to the web deployment workflow.

## Recommended Rollout Order

1. Rename the public binary from `diffly-cli` to `diffly`.
2. Add a tag-based release pipeline that builds signed or checksummed binaries for:
   - macOS Apple Silicon
   - macOS Intel
   - Linux x86_64
   - Windows x86_64
3. Publish GitHub Release assets and document direct install/download flows.
4. Add a Homebrew tap that installs from those release artifacts.
5. Make the Rust workspace publishable if `cargo install` is still desirable.
6. Add an npm wrapper package only if `npx` ergonomics are worth the maintenance cost.

## Concrete Repo Changes

### Phase 1: binary-first release path

- rename the CLI binary to `diffly`
- add release metadata and packaging configuration
- add a dedicated GitHub Actions release workflow triggered by version tags
- attach archives and checksums to GitHub Releases
- document install instructions in `README.md`

Suggested install UX to document first:

- download binary from GitHub Releases
- install via Homebrew tap

### Phase 2: packaging polish

- add Homebrew tap automation
- add shell completions if desired
- add version flag / release metadata embedding if not already present
- decide whether to produce archive names and install snippets that match `diffly` branding exactly

### Phase 3: optional ecosystem channels

- publish crates to crates.io for `cargo install`
- add `cargo-binstall` install instructions
- publish npm wrapper package for `npx diffly`

## Decision Framework

When evaluating any new distribution channel, ask:

- Does it install prebuilt binaries, or force source compilation?
- Does it improve UX for a meaningful audience segment?
- Does it become a new source of truth, or simply point at release artifacts?
- Can it be automated from the same release tag without hand-maintained steps?

If the answer to the last two questions is no, it is probably too expensive for the current stage of the project.

## Suggested Near-Term Standard

For now, treat these as the supported install stories:

- GitHub Releases for everyone
- Homebrew for macOS users
- `cargo-binstall` for Rust-oriented users once release artifacts exist

Treat these as later/optional:

- `cargo install`
- npm / `npx`
- Scoop, WinGet, apt, or other OS-specific package managers

## Open Questions

- Should the package/crate name remain `diffly-cli` internally while the shipped binary is `diffly`, or should naming be unified now?
- Do you want `cargo install diffly` as a first-class promise, or is binary distribution sufficient for v1?
- Is `npx diffly` a real user need, or just ecosystem pressure from current tooling trends?

## Proposed Default

Unless a stronger distribution requirement appears, the default publishing strategy should be:

- canonical: GitHub Releases with prebuilt binaries
- convenience: Homebrew
- optional later: `cargo-binstall`, `cargo install`, npm wrapper

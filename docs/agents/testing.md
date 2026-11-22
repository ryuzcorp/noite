# Tests and changelog fragments

Read before writing or debugging a test, or adding release notes.

## Test hygiene

Tests must catch real, consumer-visible bugs. No retries, no wall-clock sleeps in tests: flakes are bugs, fix them at the root — poll the real condition (`expect.poll`), await a real signal, inject the clock (hand-fired timers, paused time, fake timers), or use `AbortSignal.timeout` for a pure deadline. `docker/check-tests.ts` (run in `check.yml`) enforces this; `docker/check-tests.test.ts` unit-tests the checker. One `bun test` run shares one global object: a UI test that installs a browser global (`window`, `document`, the `HTMLElement`/`Node` family, `fetch`, `setTimeout`, the browser stores) must restore it before it ends. `apps/noite/bunfig.toml` preloads `src/testing/leaked-globals.ts`, which fails the leaking test — a stray `window` without `location` otherwise makes a later file's SSR render throw in `appUrl()` and paints ilha's error view instead of the tree (#392).

A fail-before test proves a fix: reproduce the bug first, then revert the fix and confirm the test fails.

## Changelog fragments

Release notes go in `changelog.d/<unique-topic>.md` (one file per PR, the CHANGELOG's own `### <Section>` headings with `- ` bullets), never under `## [Unreleased]` — `bun docker/check-changelog.ts` fails otherwise. Add an `### Operator action required` bullet whenever an upgrading operator must know or do something.

## PR size

Prefer small, focused changes. When a PR-like diff is large this repo expects the work to be split into reviewable steps.

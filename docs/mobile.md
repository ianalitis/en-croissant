# Mobile feasibility and first Android milestone

Status: local groundwork, not a mobile build or a release commitment.

## Baseline and existing work

Assessed on 2026-10-25 against upstream
`0c733f0f89b3f4966a818241f56898854de5e4e0`, after database rewrite #795.
The local `feat/903-android-preview` branch starts at that revision. It preserves
current database/vision initialization, rather than copying an older backend.

- [#903](https://github.com/franciscoBSalgueiro/en-croissant/issues/903): the reporter
  already mentions Android and wants openings, PGN review, and Stockfish analysis.
  Do not ask them to repeat their platform or feature list.
- [#1031](https://github.com/franciscoBSalgueiro/en-croissant/pull/1031): existing
  mobile library-entry groundwork. This branch refreshes that same approach on
  current upstream, with a target-platform regression. It is not a competing PR.
- [#795](https://github.com/franciscoBSalgueiro/en-croissant/pull/795): merged
  database rewrite introduces DuckDB/AIX dependencies and resource preparation.
- [#940](https://github.com/franciscoBSalgueiro/en-croissant/pull/940): the maintainer
  closed the server/library split, stating there are no plans to support the app
  outside the application or through a server. This is not a mobile rejection,
  but a web/server contribution must not assume upstream acceptance.
- [#1037](https://github.com/franciscoBSalgueiro/en-croissant/pull/1037): active
  native CI work. Coordinate rather than adding a competing workflow. Its older
  build results are not evidence for this revision.

## Assessment of the supplied research

**Prefer a bounded Tauri Android port. Do not make PWA conversion a prerequisite.**
Tauri 2 supports mobile, but that does not make this application mobile-ready.
A web manifest cannot replace the Rust backend. Frontend asset compilation does
not demonstrate that the application runs in a browser or a mobile WebView.

The research correctly identifies the entry-point, native startup, storage,
engine, and database boundaries. Its later recommendation to validate native
compilation early is stronger than its earlier browser/PWA-first sequence.
Treat its proposed interfaces and directory tree as options, not an implementation
checklist. No domain migration, monorepo, universal service layer, alternate
framework, or remote server is needed to prove the first workflow.

| Evidence in the current source                                                                                            | Consequence                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `App.tsx` starts splashscreen IPC, native logging, updater, CLI and deep-link handling.                                   | Mobile needs deliberate startup selection. Browser compatibility needs more than guarding one call.                                |
| Router startup loads four native directories. `utils/directories.ts` uses document/home paths and native filesystem APIs. | Prove app-private persistence and platform file-picker/content-URI behavior. Do not assume desktop absolute paths work on Android. |
| `src-tauri/src/engine/process.rs` owns subprocess stdin/stdout and spawns executables.                                    | Arbitrary desktop UCI binaries are not a mobile engine strategy.                                                                   |
| `Cargo.toml`, `lib.rs`, and capabilities still include desktop plugins.                                                   | Gate dependencies, registration and permissions consistently. The library entry point alone is insufficient.                       |
| `tauri.conf.json` always prepares AIX and bundles its extension and vision resources.                                     | Android must not silently package a host-macOS extension. Verify merged configuration and actual packaged resources.               |

DuckDB/AIX and vision are **unverified on mobile**, not proven universally
incompatible. Defer them from the first phone workflow instead of claiming a
full port. A single-threaded Stockfish WASM worker is a candidate, not a validated
backend: test worker/WASM loading inside the packaged WebView before choosing it.
Do not extract the desktop UCI transport merely to create an unused interface.

## Smallest useful milestone

A debug APK must open a bundled or imported PGN offline, allow legal board/move
navigation, save an annotation, and recover it after process death and relaunch.
That is an internal study milestone, not a replacement for the reporter's analysis
workflow. Clearly mark engine analysis unavailable until a real backend works.

1. **Native build spike:** preserve desktop behavior, separate desktop dependencies,
   commands, startup and resources, generate Android using the installed Tauri CLI,
   then compile/link an ARM64 debug APK. No fake successful commands or broad
   permission grants to get a shell booting.
2. **Study workflow:** reuse chessops/Chessground and existing PGN semantics.
   Add only the composition and storage boundaries this workflow requires. Phone
   layout must not depend on hover, right-click, keyboard shortcuts or desktop
   panel resizing. Keep tablet layout distinct from runtime capability.
3. **Persistence and lifecycle:** handle picker cancellation, malformed PGN,
   promotion/variations, storage errors and process death. Checkpoint durable state
   before suspension. Verify offline cold launch and export/import round-trip.
4. **Analysis spike:** prove bundled offline engine loading, licensing/source
   obligations, bounded memory, cancellation and stale-result rejection on a real
   Android WebView. Stop analysis in background and do not automatically resume
   expensive work. No remote analysis or arbitrary executable installation in v1.
5. **Tester gate:** install and launch on an emulator and a physical Android device,
   inspect crash/log output, test touch and file exchange, record device/OS and APK
   hash, and provide limitations and reproducible build/source information. Use a
   clearly experimental identity to avoid implying an official upstream release.

An iOS simulator compile is an early separate compatibility gate after Android
build feasibility, not evidence from an Android APK. iOS distribution, release
signing, app-store accounts and publication remain separate work and approvals.
Do not promise availability dates before these gates pass.

## Changes in this branch

- Expose current initialization as `en_croissant_lib::run()` with Tauri's mobile
  entry-point annotation and `staticlib`, `cdylib`, `rlib` outputs.
- Preserve the desktop launcher and Windows subsystem attribute.
- Resolve `VITE_PLATFORM` from `TAURI_ENV_PLATFORM`, mapping Windows/macOS to the
  existing Node spellings and falling back to the host for plain Vite.
- Add seven regression cases covering Android, iOS, Windows, macOS, Linux and
  absent/empty target environment values.

No dependency versions, generated bindings, permissions, startup behavior, engine
implementation, release configuration or public PR branch were changed.
This is foundational source work, **not a claim that Android compiles**.

## Validation at this revision

Installed baseline: Node 26.10.0, pnpm 12.15.0, Rust 1.98.1, Tauri CLI 2.10.0,
Java 17.0.20.1, Android SDK platform 36, build-tools 35.0.0/36.0.0, NDK 27.1.12297006.
Only the host Rust target is installed on the inspected toolchains.

| Check                                                         | Result                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Current-upstream frontend baseline                            | 70 tests passed; TypeScript passed.                                                                                               |
| Target regression before fix                                  | Four expected failures: Android/iOS/Windows/Linux used the macOS build host.                                                      |
| Target regression after fix                                   | All seven passed.                                                                                                                 |
| Full candidate frontend suite                                 | 77 tests passed.                                                                                                                  |
| Candidate TypeScript                                          | Passed.                                                                                                                           |
| Candidate frontend build                                      | Passed with bundler warnings. Not browser/native runtime acceptance.                                                              |
| Candidate lint                                                | Zero errors, 96 warnings in unchanged application code.                                                                           |
| Changed TypeScript formatting and Rust entry-point formatting | Passed.                                                                                                                           |
| Entry-point preservation                                      | Exact relocation comparison against pinned upstream passed; Cargo metadata recognizes library and binary; dependencies unchanged. |
| Desktop Rust check, baseline and candidate                    | Blocked offline by uncached pinned `aix-chess-compression` revision `9cacddc2`.                                                   |
| Android/iOS compile, install, launch and device workflow      | Not run. Required Rust targets are not installed.                                                                                 |
| Independent Astra/high review                                 | Not performed; dispatch admission unresolved. No review or acceptance is implied.                                                 |

Use repository-local binaries for frontend checks when avoiding package-manager
installation side effects. The normal project scripts remain unchanged. For
native checks, obtain approval to fetch the existing locked dependencies and
install the required target toolchains first. Do not substitute old desktop
artifacts, old test results, source inspection or Cargo metadata for compilation.

## Primary references checked

Documentation was obtained through Context7 (Tauri documentation repository) and
direct fetches of Tauri primary documentation on 2026-10-25. The supplied research
is secondary material, not build evidence.

- [Mobile entry point](https://v2.tauri.app/start/migrate/from-tauri-1/)
- [Mobile prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Development and `TAURI_DEV_HOST`](https://v2.tauri.app/develop/)
- [Single-instance desktop target selection](https://v2.tauri.app/plugin/single-instance/)
- [WebDriver limitations](https://v2.tauri.app/develop/tests/webdriver/): the
  recommended embedded service covers desktop Windows/Linux/macOS; this does not
  establish Android/iOS automation. Direct `tauri-driver` is a different path.

Before any submission, refresh upstream HEAD, issue discussion, reviews and
open/closed/merged overlap again. Public communication must describe independent
contributor exploration, not an upstream roadmap or a promised quick APK.

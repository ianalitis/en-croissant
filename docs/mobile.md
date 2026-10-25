# Mobile feasibility and first Android milestone

Status: Android ARM64 library builds locally. APK packaging and device workflow acceptance remain incomplete.

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

## Reuse prior art from the second research document

The second document strengthens the shared-implementation approach, but its
folder tree and interface list are not prerequisites. Keep existing working
TypeScript chess behavior in TypeScript and Rust behavior in Rust. Extract a
boundary only for an actual second target or a concrete native integration.

- **Readest:** its [architecture](https://github.com/readest/readest/blob/f1e1836d019b94061e7363a54bf27ea65a54c358/apps/readest-app/docs/architecture.md)
  documents one React application across Tauri desktop/mobile and web. Its
  `environment.ts` selects native/web service implementations and publishes the
  native instance only after initialization succeeds. Its database directory
  contains native/web/Node implementations plus shared migrations. Borrow focused
  service selection and initialization ownership, not its Next.js, cloud, sync,
  database choice, or broad application service. Documentation claims are not a
  complete audit of that project's dependency boundaries.
- **Historical Lichess mobile:** the [archived application](https://github.com/lichess-org/lichobile/blob/8d97c91477082143d7e791199a25424ae4f3df56/README.md)
  used a TypeScript/Mithril/Capacitor UI and a native Stockfish plugin, with explicit
  NNUE asset preparation. Its README declares end of life and replacement by the
  Flutter application. This proves useful historical native-bridge prior art,
  not a current Tauri template or a reason to migrate frameworks.
- **Engine boundary:** the [Capacitor Stockfish plugin](https://github.com/veloce/capacitor-stockfish)
  exposes start, command, output events, exit, CPU architecture and memory limits.
  Those operations inform a small mobile spike. Its API does not by itself prove
  request identity, cancellation races or lifecycle safety. Compare an embedded
  native engine with the WASM candidate on actual devices before committing to
  either. Keep desktop subprocess behavior intact.
- **Tauri mobile plugins:** the [official guide](https://v2.tauri.app/develop/plugins/develop-mobile/)
  supports Kotlin/Swift bridges, separate desktop/mobile modules and shared Rust
  through JNI/FFI. A plugin is justified for a demonstrated native operation, not
  merely for organizing existing code. Engine work must not block the UI thread.
- **Specta is already implemented:** `Cargo.toml`, `lib.rs` command/event builders
  and `src/bindings/generated.ts` already provide the suggested generated IPC
  boundary. Preserve it rather than install or replace it. Generated types do not
  validate imported PGN content or grant runtime permissions.

For document exchange, share import/export behavior rather than desktop absolute
paths. Define cancellation and durable ownership of imported content. For engine
analysis, share result semantics, session/request ownership and cancellation,
not a child-process handle. A browser test adapter need not become a PWA product.

Do not add a second storage system or new data schema merely to follow the
research's sample `StudyRepository`. First test whether the existing native data
ownership and portable PGN behavior can support the selected phone workflow.
Defer account sync and broad module moves. Touch alternatives, promotion,
variation selection, Android Back, safe areas, keyboard occlusion, rotation,
screen-reader labels, interrupted saves and upgrade preservation belong in the
workflow acceptance criteria, not a final cosmetic pass. Borrowed code, bundled
engines and NNUE assets require license/source review before distribution.

## Independent review findings

Two independent Astra reviewers assessed native feasibility and mobile reuse
against groundwork commit `6e6bbd50`. The captain checked the material source
references below. These are source/research reviews, not compiled-device results.

1. **Entry point:** exact comparison confirms current desktop initialization was
   moved without changing its control flow. This does not establish Android
   compatibility or replace a fresh desktop build/smoke test.
2. **Debug startup:** `lib.rs` exports Specta bindings to
   `../src/bindings/generated.ts` under `debug_assertions` and panics on failure.
   An Android debug app must not attempt this development-repository write on the
   device. Keep generation on the development host rather than disabling debug
   checks or hand-editing bindings.
3. **Native target isolation:** single-instance/window-state registration and
   desktop plugin dependencies remain unconditional. The AIX preparation script
   selects `process.platform`/`process.arch` and accepts an existing nonempty file
   without verifying its target. Merely changing the library target is not enough.
   First prove one ARM64 launch and IPC call with correctly scoped resources.
4. **Durable edits and training:** `debouncedStorage.ts` queues writes for 300 ms
   into `sessionStorage` and flushes on `beforeunload`/`pagehide`. That is not a
   process-death durability contract. Confirm app-private durable writes before
   showing Saved, and test termination inside the debounce interval. Practice
   progression also uses 300 ms timers, requiring suspension/double-grading tests.
5. **Reuse without overpromising:** Chessground already supports tap-selection and
   dragging; retain those controls. Its wrapper has no explicit destroy cleanup,
   and asynchronous startup listeners can outlive an early cleanup. Treat these
   as remount/lifecycle checks to reproduce, not as demonstrated Android defects.
   Preserve Specta and existing chess behavior; do not copy Readest's service
   surface or implement both native and WASM engines before a device comparison.

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

- Scope CLI, updater, single-instance and window-state dependencies to desktop,
  and gate single-instance/window-state registration without changing desktop order.
- Keep debug Specta export on desktop, where the source repository exists.
- Move the three desktop-only plugin grants into a desktop-scoped capability.
  The desktop permission union is unchanged. Five target-selection tests cover
  Android/iOS exclusion and macOS/Windows/Linux preservation.

- Select Rustls for Android's direct HTTP client instead of requiring a target
  OpenSSL installation. Non-Android TLS selection is unchanged.

- Exclude the desktop AIX and unvalidated image-inference resources through
  Android's JSON merge patch, and skip host AIX preparation. Preserve sound mapping.
  Android leaves the extension path unset, so opening a new DuckDB pool reports
  an error rather than loading a host-native extension.

- Keep Candle/image dependencies and the existing recognition implementation on
  non-Android targets. Android retains the IPC command but returns an explicit
  unsupported error. No fake position, CPU-feature override or inference claim.
- Keep desktop splashscreen window visibility handling off mobile targets.

No dependency versions, generated bindings, engine implementation, release
configuration or public PR branch were changed. Native startup and permission
selection now follow the target. This is an Android build spike,
**not a usable mobile release or a validated study workflow**.

## Validation at this revision

Installed baseline: Node 26.10.0, pnpm 12.15.0, Rust 1.98.1, Tauri CLI 2.10.0,
Java 17.0.20.1, Android SDK platform 36, build-tools 35.0.0/36.0.0, NDK 27.1.12297006.
The initial inspection found only the host Rust target. The follow-through installed
`aarch64-linux-android` and `x86_64-linux-android` on the existing Rust 1.98.1
and fetched dependencies at the existing lockfile versions. No toolchain upgrade.

Tauri CLI `android init --ci --skip-targets-install` successfully generated the
Android project using the existing SDK. It remains local and ignored under
`src-tauri/gen/`, following the repository's existing ignore rule. Generated build
versions are Gradle 8.14.3, Android Gradle Plugin 8.11.0, Kotlin 1.9.25, SDK 36,
minimum Android API 24. The pinned Gradle wrapper successfully reports 8.14.3
under existing Java 17. Android dependency resolution/assembly has not completed.

A real ARM64 `cargo check --lib --locked --target aarch64-linux-android`, using
NDK 27.1's API-24 Clang toolchain, initially stopped at `openssl-sys 0.9.101`:
no Android OpenSSL installation. The dependency tree traced this to the direct
`reqwest 0.12.5` default TLS feature. Android now selects the existing Rustls
backend while non-Android keeps the exact prior dependency declaration. The
Android resolved graph no longer includes OpenSSL/default TLS; the macOS graph
still includes default TLS. Versions and the lockfile remain unchanged.

The subsequent check passed that dependency stage and reached the application
build script, which failed because the desktop AIX extension resource was missing.
Android excludes the desktop extension through Tauri's JSON merge patch. Its
resource-selection build-script output retains sound files. Desktop preparation
is unchanged. This is not a DuckDB port: Android's extension path stays unset and
new DuckDB pool acquisition returns an error. A separate Astra/high review verified the merge and
failure path. It also confirmed that not all database commands use that path:
existing empty imports, deletion and compaction have different behavior. Database
controls must be unavailable before user testing; this guard is not a sandbox.

The real `tauri android build --ci --target aarch64 --debug --apk` accepted the
platform configuration and completed the frontend build, then failed compiling
`gemm-f16 0.19.0` with eleven `instruction requires: fullfp16` errors. The dependency
tree traced it to Candle's image-recognition backend. Android now excludes that
backend and its unused assets, with the existing recognition IPC returning an
explicit unsupported error. Desktop/iOS declarations and original inference
source are unchanged. No global CPU-feature flag was added.

A further Astra/high review found no blocking source defect in this exclusion.
The actual Android build script completed resource selection with sound files
and no AIX/vision files, and the Android dependency graph excludes Candle.
Compilation then exposed the desktop-only `WebviewWindow.show()` call in
`close_splashscreen`. Its existing operation and `Emitter` import are now scoped
to desktop. Mobile acknowledges the visibility command without trying to unhide
a desktop window. The injected window argument is not part of the frontend IPC
payload. An independent source follow-up verified this correction.

The next real Android build **compiled and linked** the ARM64 shared library in
54.98 seconds. ELF inspection confirms AArch64. Two unchanged-code warnings
remain: unused `Semaphore` and `NotDistinctPlayers`. This is native build evidence,
not runtime visibility, file persistence, engine analysis or device acceptance.
The debug library is approximately 1 GB with debug symbols and is not suitable
for tester distribution in this form.

APK assembly then failed in generated Gradle task `rustBuildArm64Debug`: its
callback executes `node tauri` from `src-tauri`, where that module does not exist.
Calling the existing CLI's real relative path with `android android-studio-script
--help` succeeds. Correct/regenerate the callback without skipping its Rust build
verification, then rerun packaging. No APK was produced.

The oversized debug artifact needs a lower-debug-information build before tester
packaging. Hide unavailable image recognition/database controls before user testing.

A separate Astra/high source review found no blocking issue in the Android TLS
selection. Rustls uses bundled WebPKI roots, not automatic Android system or
user-installed CA trust. No certificate validation was disabled, but live HTTPS
and custom-CA behavior remain untested. The HTTP plugin already selected Rustls;
OAuth's separate reqwest 0.11 dependency is unchanged.

| Check                                                         | Result                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current-upstream frontend baseline                            | 70 tests passed; TypeScript passed.                                                                                                                     |
| Target regression before fix                                  | Four expected failures: Android/iOS/Windows/Linux used the macOS build host.                                                                            |
| Target regression after fix                                   | All seven passed.                                                                                                                                       |
| Full candidate frontend suite                                 | 83 tests passed, including six mobile capability/resource configuration cases.                                                                          |
| Candidate TypeScript                                          | Passed.                                                                                                                                                 |
| Candidate frontend build                                      | Passed with bundler warnings. Not browser/native runtime acceptance.                                                                                    |
| Candidate lint                                                | Zero errors, 96 warnings in unchanged application code.                                                                                                 |
| Changed TypeScript formatting and Rust entry-point formatting | Passed.                                                                                                                                                 |
| Entry-point preservation                                      | Exact relocation at groundwork commit checked against pinned upstream. Later gates preserve desktop plugin order and dependency versions by inspection. |
| Initial desktop Rust check at groundwork commit               | Blocked offline by uncached AIX revision `9cacddc2`; dependency since fetched, no fresh desktop compile acceptance.                                     |
| Android/iOS compile, install, launch and device workflow      | ARM64 Rust compile/link passed. APK packaging fails at generated CLI callback. No APK, launch, device workflow or iOS compile.                          |
| Independent Astra/high review                                 | Two independent read-only Astra reviews completed; key findings checked against source. Native acceptance remains unverified.                           |

Use repository-local binaries for frontend checks when avoiding package-manager
installation side effects. The normal project scripts remain unchanged. The named
Android target and locked dependency preparation has completed. Additional
installations, signing, device installation and publication remain separate
scopes. Do not substitute old desktop artifacts, old test results, source
inspection or Cargo metadata for compilation.

A third independent Astra/high source review covered the desktop plugin gates.
Its capability finding was resolved by the platform split and independently
rechecked against the final files. The review did not compile or run the app.
Complexity check: keep target-scoped dependency/permission declarations and two
builder gates; no new platform framework, service abstraction or duplicated app.

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

use super::*;
use crate::engine::maia_conditioning_tests::{opts, Fixture as MaiaFixture, SIGNATURE};
use std::{cell::Cell, future::poll_fn, os::unix::fs::PermissionsExt, task::Poll, time::Duration};
use tauri::{
    test::{mock_builder, mock_context, noop_assets, MockRuntime},
    Listener, Manager,
};
use tokio::time::{sleep, timeout};

const ID: &str = "report-lifecycle";
const FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const CANCEL_DEADLINE: Duration = Duration::from_secs(1);
const WATCHDOG: Duration = Duration::from_secs(12);

thread_local! {
    static COMPLETED_PLIES: Cell<usize> = const { Cell::new(0) };
}

// Observation only: no yield or cancellation mutation inside preprocessing.
pub(super) fn record_completed_ply() {
    COMPLETED_PLIES.with(|count| count.set(count.get() + 1));
}

// These calls only inspect/wait for the exact child recorded by our disposable fixture.
// No signals, global process enumeration, or descendant processes are involved.
unsafe extern "C" {
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

struct Fixture {
    directory: tempfile::TempDir,
    path: PathBuf,
}

impl Fixture {
    fn new(mode: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine");
        let script = format!(
            r#"#!/bin/bash
printf '%s' "$$" > child.pid
mode='{mode}'
count=0
# Builtins only, with an independent finite lifetime even on test assertion failure.
stall() {{
    printf '%s' "$1" > phase
    while (( SECONDS < 8 )); do :; done
    exit 91
}}
while IFS= read -r -t 8 line; do
    case "$line" in
        uci)
            [ "$mode" = uci ] && stall uci
            [ "$mode" = init_eof ] && exit 0
            printf 'uciok\n'
            ;;
        isready)
            [ "$mode" = ready ] && stall ready
            [ "$mode" = write_error ] && exec 0<&-
            printf 'readyok\n'
            [ "$mode" = write_error ] && stall write_error
            [ "$mode" = write ] && stall write
            ;;
        go*)
            count=$((count + 1))
            [ "$mode" = bestmove ] && stall bestmove
            [ "$mode" = final ] && [ "$count" = 2 ] && stall final
            [ "$mode" = eof ] && exit 0
            if [ "$mode" = read_error ]; then
                printf '\377\n'
                stall read_error
            fi
            printf 'bestmove e2e4\n'
            ;;
        quit) : ;; # Deliberately ignore graceful shutdown.
    esac
done
"#
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self { directory, path }
    }

    fn pid(&self) -> Option<i32> {
        std::fs::read_to_string(self.directory.path().join("child.pid"))
            .ok()?
            .parse()
            .ok()
    }

    async fn phase(&self, expected: &str) {
        timeout(WATCHDOG, async {
            loop {
                if std::fs::read_to_string(self.directory.path().join("phase"))
                    .is_ok_and(|phase| phase == expected)
                {
                    break;
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fixture never reached expected phase");
    }

    fn assert_reaped(&self) {
        let pid = self.pid().expect("fixture must have started");
        let mut status = 0;
        // WNOHANG=1, ECHILD=10 on the supported macOS/Linux Unix test hosts.
        let result = unsafe { waitpid(pid, &mut status, 1) };
        let errno = std::io::Error::last_os_error().raw_os_error();
        assert_eq!(
            result, -1,
            "report returned without reaping child {pid}, status={status}"
        );
        assert_eq!(
            errno,
            Some(10),
            "waitpid must prove ECHILD, not merely a missing PID"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(pid) = self.pid() {
            // On assertion failure the report future drops first (BaseEngine kills).
            // The shell also has an independent 8-second watchdog. Reap any remainder.
            let mut status = 0;
            loop {
                let result = unsafe { waitpid(pid, &mut status, 0) };
                if result >= 0
                    || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                {
                    break;
                }
            }
        }
    }
}

fn app() -> tauri::App<MockRuntime> {
    COMPLETED_PLIES.with(|count| count.set(0));
    let app = mock_builder()
        .manage(AppState::default())
        .build(mock_context(noop_assets()))
        .unwrap();
    tauri_specta::Builder::<MockRuntime>::new()
        .events(tauri_specta::collect_events![
            crate::progress::ProgressEvent
        ])
        .mount_events(&app);
    app
}

fn options() -> AnalysisOptions {
    AnalysisOptions {
        fen: FEN.into(),
        ..Default::default()
    }
}

async fn run(
    app: &tauri::App<MockRuntime>,
    path: &std::path::Path,
    options: AnalysisOptions,
    uci_options: Vec<EngineOption>,
) -> Result<Vec<MoveAnalysis>, Error> {
    analyze_game_inner(
        ID.into(),
        path.to_string_lossy().into_owned(),
        GoMode::Depth(1),
        options,
        uci_options,
        app.state(),
        app.handle().clone(),
    )
    .await
}

async fn cancelled_at(mode: &str) {
    let app = app();
    let fixture = Fixture::new(mode);
    let mut options = options();
    if mode == "final" {
        options.moves = vec!["e2e4".into()];
    }
    let uci_options = if mode == "write" {
        vec![EngineOption {
            name: "LargeOption".into(),
            value: "x".repeat(2 * 1024 * 1024),
        }]
    } else {
        vec![]
    };
    let report = run(&app, &fixture.path, options, uci_options);
    tokio::pin!(report);
    let result = timeout(WATCHDOG, async {
        tokio::select! {
            result = &mut report => panic!("report finished before cancellation: {result:?}"),
            () = fixture.phase(mode) => {}
        }
        cancel_analysis(ID.into(), app.state()).await.unwrap();
        cancel_analysis(ID.into(), app.state()).await.unwrap();
        timeout(CANCEL_DEADLINE, &mut report)
            .await
            .expect("cancel did not wake stalled report")
    })
    .await
    .expect("outer lifecycle watchdog expired");
    assert!(
        matches!(result, Err(Error::AnalysisCancelled)),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_cancel_stalled_uci() {
    cancelled_at("uci").await;
}
#[tokio::test]
async fn report_lifecycle_cancel_stalled_ready() {
    cancelled_at("ready").await;
}
#[tokio::test]
async fn report_lifecycle_cancel_stalled_bestmove() {
    cancelled_at("bestmove").await;
}
#[tokio::test]
async fn report_lifecycle_cancel_final_position() {
    cancelled_at("final").await;
}
#[tokio::test]
async fn report_lifecycle_cancel_blocked_option_write() {
    cancelled_at("write").await;
}

#[tokio::test]
async fn report_lifecycle_success_reaps_engine_ignoring_quit() {
    let app = app();
    let fixture = Fixture::new("success");
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options(), vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.len(), 1);
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_eof_is_error_and_reaped() {
    let app = app();
    let fixture = Fixture::new("eof");
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options(), vec![]))
        .await
        .unwrap();
    assert!(
        matches!(result, Err(Error::EngineDisconnected)),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_read_error_is_not_success() {
    let app = app();
    let fixture = Fixture::new("read_error");
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options(), vec![]))
        .await
        .unwrap();
    assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_init_eof_cleans_registration() {
    let app = app();
    let fixture = Fixture::new("init_eof");
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options(), vec![]))
        .await
        .unwrap();
    assert!(
        matches!(result, Err(Error::EngineDisconnected)),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_invalid_input_cleans_registration() {
    let app = app();
    let fixture = Fixture::new("success");
    let mut invalid = options();
    invalid.fen = "not a fen".into();
    let result = timeout(WATCHDOG, run(&app, &fixture.path, invalid, vec![]))
        .await
        .unwrap();
    assert!(matches!(result, Err(Error::Fen(_))), "{result:?}");
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_spawn_error_and_missing_cancel_are_clean() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    cancel_analysis(ID.into(), app.state()).await.unwrap();
    let result = run(
        &app,
        &directory.path().join("missing-engine"),
        options(),
        vec![],
    )
    .await;
    assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    cancel_analysis(ID.into(), app.state()).await.unwrap();
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
}

#[tokio::test]
async fn report_lifecycle_annotation_error_after_reap() {
    let app = app();
    let fixture = Fixture::new("success");
    let mut options = options();
    options.annotate_novelties = true;
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options, vec![]))
        .await
        .unwrap();
    assert!(
        matches!(result, Err(Error::MissingReferenceDatabase)),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_same_id_cancels_old_and_preserves_new_registration() {
    let app = app();
    let old_fixture = Fixture::new("uci");
    let new_fixture = Fixture::new("ready");
    let old = run(&app, &old_fixture.path, options(), vec![]);
    tokio::pin!(old);
    tokio::select! {
        result = &mut old => panic!("old report unexpectedly finished: {result:?}"),
        () = old_fixture.phase("uci") => {}
    }
    let old_flag = app
        .state::<AppState>()
        .analysis_cancel_flags
        .get(ID)
        .unwrap()
        .clone();
    let new = run(&app, &new_fixture.path, options(), vec![]);
    tokio::pin!(new);
    tokio::select! {
        result = &mut new => panic!("new report unexpectedly finished: {result:?}"),
        () = new_fixture.phase("ready") => {}
    }
    let new_flag = app
        .state::<AppState>()
        .analysis_cancel_flags
        .get(ID)
        .unwrap()
        .clone();
    assert!(!Arc::ptr_eq(&old_flag, &new_flag));
    assert!(
        old_flag.load(Ordering::SeqCst),
        "replacement must cancel the previous report"
    );
    let result = timeout(CANCEL_DEADLINE, &mut old)
        .await
        .expect("old report did not wake");
    assert!(
        matches!(result, Err(Error::AnalysisCancelled)),
        "{result:?}"
    );
    assert!(Arc::ptr_eq(
        &new_flag,
        &app.state::<AppState>()
            .analysis_cancel_flags
            .get(ID)
            .unwrap()
    ));
    old_fixture.assert_reaped();
    cancel_analysis(ID.into(), app.state()).await.unwrap();
    let result = timeout(CANCEL_DEADLINE, &mut new)
        .await
        .expect("new report did not wake");
    assert!(
        matches!(result, Err(Error::AnalysisCancelled)),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    new_fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_native_write_error_is_preserved_and_reaped() {
    let app = app();
    let fixture = Fixture::new("write_error");
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options(), vec![]))
        .await
        .unwrap();
    assert!(
        matches!(&result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::BrokenPipe),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_illegal_move_is_preserved_and_reaped() {
    let app = app();
    let fixture = Fixture::new("success");
    let mut options = options();
    options.moves = vec!["e2e5".into()];
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options, vec![]))
        .await
        .unwrap();
    assert!(
        matches!(result, Err(Error::IllegalUciMove(_))),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

async fn cancel_during_preprocessing(moves: &[&str]) -> (Result<Vec<MoveAnalysis>, Error>, usize) {
    let app = app();
    let fixture = Fixture::new("success");
    let mut options = options();
    options.moves = moves.iter().map(|m| (*m).into()).collect();
    let (result, ()) = timeout(WATCHDOG, async {
        // futures_util::join! polls in argument order, keeping the report first.
        futures_util::join!(run(&app, &fixture.path, options, vec![]), async {
            poll_fn(|_| {
                if COMPLETED_PLIES.with(Cell::get) >= 2 {
                    Poll::Ready(())
                } else {
                    Poll::Pending
                }
            })
            .await;
            cancel_analysis(ID.into(), app.state()).await.unwrap();
        })
    })
    .await
    .expect("preprocessing cancellation watchdog expired");
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
    (result, COMPLETED_PLIES.with(Cell::get))
}

#[tokio::test(flavor = "current_thread")]
async fn report_lifecycle_preprocessing_cancel_before_illegal_tail() {
    let (result, completed) = cancel_during_preprocessing(&["e2e4", "e7e5", "e2e5"]).await;
    assert!(
        matches!(result, Err(Error::AnalysisCancelled)),
        "{result:?}"
    );
    assert_eq!(completed, 2, "cancellation must precede the illegal tail");
}

#[tokio::test(flavor = "current_thread")]
async fn report_lifecycle_preprocessing_cancel_before_legal_tail() {
    let (result, completed) = cancel_during_preprocessing(&["e2e4", "e7e5", "g1f3", "b8c6"]).await;
    assert_eq!(
        completed, 2,
        "cancellation must skip the remaining legal plies"
    );
    assert!(
        matches!(result, Err(Error::AnalysisCancelled)),
        "{result:?}"
    );
}

async fn successful_two_ply_report(reversed: bool) {
    let app = app();
    let fixture = Fixture::new("success");
    let mut options = options();
    options.moves = vec!["e2e4".into(), "e7e5".into()];
    options.reversed = reversed;
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options, vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(COMPLETED_PLIES.with(Cell::get), 2);
    assert_eq!(result.len(), 3);
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test(flavor = "current_thread")]
async fn report_lifecycle_preprocessing_two_ply_success() {
    successful_two_ply_report(false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn report_lifecycle_preprocessing_two_ply_reversed_success() {
    successful_two_ply_report(true).await;
}

#[tokio::test]
async fn report_lifecycle_last_cancellation_check_prevents_success() {
    let app = app();
    let fixture = Fixture::new("success");
    let handle = app.handle().clone();
    let observed = Arc::new(AtomicBool::new(false));
    let recorded = observed.clone();
    app.listen(crate::progress::ProgressEvent::NAME, move |event| {
        let event: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        if event["finished"] == true {
            recorded.store(true, Ordering::SeqCst);
            handle
                .state::<AppState>()
                .analysis_cancel_flags
                .get(ID)
                .unwrap()
                .store(true, Ordering::SeqCst);
        }
    });
    let result = timeout(WATCHDOG, run(&app, &fixture.path, options(), vec![]))
        .await
        .unwrap();
    assert!(observed.load(Ordering::SeqCst));
    assert!(
        matches!(result, Err(Error::AnalysisCancelled)),
        "{result:?}"
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_shared_quit_stop_remain_commands_and_report_reap_is_repeatable() {
    let fixture = Fixture::new("success");
    let mut base = BaseEngine::spawn(fixture.path.clone()).await.unwrap();
    timeout(WATCHDOG, async {
        base.init_uci().await.unwrap();
        base.stop().await.unwrap();
        base.quit().await.unwrap();
        // The fixture ignores quit. Shared commands must not forcibly terminate it.
        base.init_uci().await.unwrap();
        base.terminate_report().await.unwrap();
        base.terminate_report().await.unwrap();
    })
    .await
    .unwrap();
    fixture.assert_reaped();
}

#[tokio::test]
async fn report_lifecycle_already_exited_child_is_waited() {
    let fixture = Fixture::new("init_eof");
    let mut base = BaseEngine::spawn(fixture.path.clone()).await.unwrap();
    timeout(WATCHDOG, async {
        assert!(matches!(
            base.init_uci().await,
            Err(Error::EngineDisconnected)
        ));
        base.terminate_report().await.unwrap();
        base.terminate_report().await.unwrap();
    })
    .await
    .unwrap();
    fixture.assert_reaped();
}

async fn maia_process(fixture: &MaiaFixture) -> EngineProcess {
    let mut base = BaseEngine::spawn(fixture.path.clone()).await.unwrap();
    timeout(WATCHDOG, base.init_uci()).await.unwrap().unwrap();
    EngineProcess::from_base(base)
}

fn maia_options(pairs: &[(&str, &str)]) -> EngineOptions {
    EngineOptions {
        fen: FEN.into(),
        moves: vec![],
        extra_options: opts(pairs),
    }
}

#[tokio::test]
async fn maia_conditioning_all_alias_channel_permutations() {
    let permutations = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    let values = [("Elo", "1800"), ("SelfElo", "2100"), ("OppoElo", "2200")];
    for order in permutations {
        let fixture = MaiaFixture::new(SIGNATURE);
        let mut process = maia_process(&fixture).await;
        let request = maia_options(&order.map(|i| values[i]));
        process.set_options(request.clone()).await.unwrap();
        fixture.sync(&mut process.base).await;
        assert_eq!(fixture.state(), "2100,2200", "order {order:?}");
        assert_eq!(
            fixture.commands(),
            [
                "setoption name UCI_Chess960 value false",
                "setoption name SelfElo value 2100",
                "setoption name OppoElo value 2200",
            ]
        );
        assert_eq!(
            process.options, request,
            "raw request equality must survive normalization"
        );
        process.base.terminate_report().await.unwrap();
        fixture.assert_reaped();
    }
}

#[tokio::test]
async fn maia_conditioning_alias_delta_replay_removal_and_explicit_defaults() {
    let fixture = MaiaFixture::new(SIGNATURE);
    let mut process = maia_process(&fixture).await;
    for (pairs, expected, delta) in [
        (
            vec![("SelfElo", "2100"), ("Elo", "1800")],
            "2100,1800",
            vec!["SelfElo value 2100", "OppoElo value 1800"],
        ),
        (
            vec![("SelfElo", "2100"), ("Elo", "1900")],
            "2100,1900",
            vec!["OppoElo value 1900"],
        ),
        (
            vec![("SelfElo", "2100"), ("Elo", "1900")],
            "2100,1900",
            vec![],
        ),
        (
            vec![("Elo", "1900")],
            "1900,1900",
            vec!["SelfElo value 1900"],
        ),
        (
            vec![],
            "1200,1300",
            vec!["SelfElo value 1200", "OppoElo value 1300"],
        ),
        (
            vec![("Elo", "1500")],
            "1500,1500",
            vec!["SelfElo value 1500", "OppoElo value 1500"],
        ),
        (
            vec![("SelfElo", "1200"), ("OppoElo", "1300"), ("Elo", "1500")],
            "1200,1300",
            vec!["SelfElo value 1200", "OppoElo value 1300"],
        ),
        (
            vec![("OppoElo", "2300")],
            "1200,2300",
            vec!["OppoElo value 2300"],
        ),
        (
            vec![("Elo", "1600"), ("eLO", "1700")],
            "1700,1700",
            vec!["SelfElo value 1700", "OppoElo value 1700"],
        ),
        (vec![("Elo", "01700")], "1700,1700", vec![]),
    ] {
        let before = fixture.commands().len();
        let request = maia_options(&pairs);
        process.set_options(request.clone()).await.unwrap();
        fixture.sync(&mut process.base).await;
        assert_eq!(fixture.state(), expected, "{pairs:?}");
        let commands: Vec<_> = fixture.commands()[before..]
            .iter()
            .filter(|cmd| !cmd.contains("UCI_Chess960"))
            .cloned()
            .collect();
        assert_eq!(
            commands,
            delta
                .iter()
                .map(|v| format!("setoption name {v}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(process.options, request);
    }
    process.base.terminate_report().await.unwrap();
    fixture.assert_reaped();
}

#[tokio::test]
async fn maia_conditioning_case_duplicates_and_unrelated_order() {
    let fixture = MaiaFixture::new(SIGNATURE);
    let mut process = maia_process(&fixture).await;
    let request = maia_options(&[
        ("Hash", "16"),
        ("sELfELO", "2000"),
        ("eLO", "1500"),
        ("MultiPV", "3"),
        ("selfelo", "2100"),
        ("Elo", "1800"),
        ("oppoelo", "0"),
        ("OPPOELO", "5000"),
        ("Threads", "2"),
        ("UCI_Chess960", "true"),
    ]);
    process.set_options(request.clone()).await.unwrap();
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.state(), "2100,5000");
    assert_eq!(
        fixture.commands(),
        [
            "setoption name UCI_Chess960 value false",
            "setoption name Hash value 16",
            "setoption name MultiPV value 3",
            "setoption name Threads value 2",
            "setoption name SelfElo value 2100",
            "setoption name OppoElo value 5000",
        ]
    );
    assert_eq!(process.real_multipv, 3);
    let before = fixture.commands();
    process.set_options(request).await.unwrap();
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.commands(), before);
    process.base.terminate_report().await.unwrap();
    fixture.assert_reaped();
}

#[tokio::test]
async fn maia_conditioning_invalid_values_precede_all_writes_and_preserve_request() {
    let fixture = MaiaFixture::new(SIGNATURE);
    let mut process = maia_process(&fixture).await;
    for value in [
        "no",
        "1800.5",
        "-1",
        "5001",
        "",
        "999999999999999999999",
        "1800\nquit",
    ] {
        for name in ["Elo", "selfelo", "OPPOELO"] {
            let before = fixture.commands();
            let old_request = process.options.clone();
            let request = maia_options(&[("Hash", "64"), (name, value), (name, "1900")]);
            let result = process.set_options(request).await;
            fixture.sync(&mut process.base).await;
            assert!(
                matches!(result, Err(Error::Io(ref e)) if e.kind() == std::io::ErrorKind::InvalidInput),
                "{name}={value:?}: {result:?}"
            );
            assert_eq!(fixture.commands(), before, "including UCI_Chess960");
            assert_eq!(fixture.state(), "1200,1300");
            assert_eq!(process.options, old_request);
        }
    }
    process.base.terminate_report().await.unwrap();
    fixture.assert_reaped();
}

#[tokio::test]
async fn maia_conditioning_report_uses_shared_options_and_reaps() {
    let app = app();
    let fixture = MaiaFixture::new(SIGNATURE);
    let result = timeout(
        WATCHDOG,
        run(
            &app,
            &fixture.path,
            options(),
            opts(&[("SelfElo", "2100"), ("Elo", "1800"), ("MultiPV", "8")]),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(fixture.state(), "2100,1800");
    assert_eq!(
        fixture.commands(),
        [
            "setoption name UCI_Chess960 value false",
            "setoption name MultiPV value 2",
            "setoption name SelfElo value 2100",
            "setoption name OppoElo value 1800",
        ]
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn maia_conditioning_signature_negative_matrix_preserves_ordinary_engine() {
    let mut signatures = vec![
        String::new(),
        SIGNATURE.replace("Maia3", "UnrelatedEngine"),
        SIGNATURE.replace("Maia3", "maia3"),
        SIGNATURE.replace("CSSLab", "OtherAuthor"),
        SIGNATURE.replace("CSSLab", "csslab"),
        SIGNATURE.replace("id author CSSLab\n", ""),
        SIGNATURE.replace("id name Maia3\n", ""),
        format!("{SIGNATURE}id name Maia3\n"),
        format!("{SIGNATURE}id author OtherAuthor\n"),
        // A matching declaration after uciok is not part of the handshake.
        format!("uciok\n{SIGNATURE}"),
    ];
    for name in ["Elo", "SelfElo", "OppoElo"] {
        let declaration = SIGNATURE
            .lines()
            .find(|line| line.starts_with(&format!("option name {name} ")))
            .unwrap();
        signatures.push(SIGNATURE.replace(&format!("{declaration}\n"), ""));
        signatures.push(format!(
            "{SIGNATURE}{}\n",
            declaration.replace(name, &name.to_ascii_lowercase())
        ));
        for malformed in [
            declaration.replace("type spin", "type string"),
            declaration.replace("min 0", "min 1"),
            declaration.replace("max 5000", "max 5001"),
            declaration.replace(" min 0", ""),
            declaration.replace(" max 5000", " max unknown"),
            declaration.replace(" max 5000", " min 0"),
            format!("{declaration} extra"),
        ] {
            signatures.push(SIGNATURE.replace(declaration, &malformed));
        }
        let default = declaration.split_whitespace().nth(6).unwrap();
        for invalid in ["-1", "5001", "x"] {
            signatures.push(SIGNATURE.replace(
                declaration,
                &declaration.replace(&format!("default {default}"), &format!("default {invalid}")),
            ));
        }
        // Malformed first, valid later must not repair an ambiguous declaration.
        signatures.push(format!(
            "option name {name} type spin default x min 0 max 5000\n{SIGNATURE}"
        ));
    }
    for signature in signatures {
        let fixture = MaiaFixture::new(&signature);
        let mut process = maia_process(&fixture).await;
        let request = maia_options(&[
            ("Hash", "16"),
            ("SelfElo", "2100"),
            ("Elo", "1800"),
            ("Threads", "2"),
        ]);
        process.set_options(request.clone()).await.unwrap();
        fixture.sync(&mut process.base).await;
        assert_eq!(fixture.state(), "1800,1800", "{signature}");
        let expected = [
            "setoption name UCI_Chess960 value false",
            "setoption name Hash value 16",
            "setoption name SelfElo value 2100",
            "setoption name Elo value 1800",
            "setoption name Threads value 2",
        ];
        assert_eq!(fixture.commands(), expected, "{signature}");
        assert!(process.emitted_options.is_none());
        process.set_options(request).await.unwrap();
        fixture.sync(&mut process.base).await;
        assert_eq!(
            fixture.commands(),
            expected,
            "ordinary replay must keep delta behavior"
        );
        // Coincident option names are not grounds to validate another engine.
        process
            .set_options(maia_options(&[("Elo", "arbitrary")]))
            .await
            .unwrap();
        fixture.sync(&mut process.base).await;
        assert_eq!(fixture.state(), "arbitrary,arbitrary");
        assert_eq!(
            fixture.commands().last().unwrap(),
            "setoption name Elo value arbitrary"
        );
        process.base.terminate_report().await.unwrap();
        fixture.assert_reaped();
    }
}

#[tokio::test]
async fn maia_conditioning_signature_positive_defaults_and_reinitialization() {
    let signature = SIGNATURE
        .replace("id name Maia3", "  id name Maia3  ")
        .replace("id author CSSLab", "id author CSSLab  ")
        .replace("name Elo", "name eLO")
        .replace("name SelfElo", "name SELFelo")
        .replace("name OppoElo", "name oppoELO")
        .replace("default 1200 min 0 max 5000", "max 5000 default 1000 min 0")
        .replace("default 1300", "default 2000");
    let fixture = MaiaFixture::new(&signature);
    let mut process = maia_process(&fixture).await;
    process.set_options(maia_options(&[])).await.unwrap();
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.state(), "1000,2000");
    assert_eq!(
        fixture.commands(),
        [
            "setoption name UCI_Chess960 value false",
            "setoption name SelfElo value 1000",
            "setoption name OppoElo value 2000"
        ]
    );

    fixture.signature("");
    timeout(WATCHDOG, process.base.init_uci())
        .await
        .unwrap()
        .unwrap();
    process
        .set_options(maia_options(&[("SelfElo", "2100"), ("Elo", "1800")]))
        .await
        .unwrap();
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.state(), "1800,1800");
    assert!(
        process.emitted_options.is_none(),
        "reinitialization must discard the signature"
    );
    assert_eq!(
        &fixture.commands()[3..],
        [
            "setoption name SelfElo value 2100",
            "setoption name Elo value 1800"
        ]
    );

    fixture.signature(SIGNATURE);
    timeout(WATCHDOG, process.base.init_uci())
        .await
        .unwrap()
        .unwrap();
    process.set_options(maia_options(&[])).await.unwrap();
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.state(), "1200,1300");
    assert_eq!(
        &fixture.commands()[5..],
        [
            "setoption name SelfElo value 1200",
            "setoption name OppoElo value 1300"
        ]
    );
    process.base.terminate_report().await.unwrap();
    fixture.assert_reaped();
}

#[tokio::test]
async fn maia_conditioning_validation_preserves_successful_cache_and_write_failure_invalidates_it()
{
    let fixture = MaiaFixture::new(SIGNATURE);
    let mut process = maia_process(&fixture).await;
    let request = maia_options(&[("Elo", "1800")]);
    process.set_options(request.clone()).await.unwrap();
    fixture.sync(&mut process.base).await;
    let before = fixture.commands();
    let cache = process.emitted_options.clone();
    let mut invalid = maia_options(&[("Elo", "bad")]);
    invalid.fen = "rkr5/pppppppp/8/8/8/8/PPPPPPPP/RKR5 w ACac - 0 1".into();
    let result = process.set_options(invalid).await;
    assert!(
        matches!(result, Err(Error::Io(ref e)) if e.kind() == std::io::ErrorKind::InvalidInput)
    );
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.commands(), before);
    assert_eq!(fixture.state(), "1800,1800");
    assert_eq!(process.options, request);
    assert_eq!(process.emitted_options, cache);

    process.base.terminate_report().await.unwrap();
    fixture.assert_reaped();
    let result = process.set_options(maia_options(&[("Elo", "1900")])).await;
    assert!(matches!(result, Err(Error::Io(ref e)) if e.kind() == std::io::ErrorKind::BrokenPipe));
    assert!(process.emitted_options.is_none());
    assert_eq!(process.options, request);
    assert_eq!(fixture.commands(), before);
    assert_eq!(fixture.state(), "1800,1800");
}

#[tokio::test]
async fn maia_conditioning_report_invalid_input_reaps_without_any_option_writes() {
    let app = app();
    let fixture = MaiaFixture::new(SIGNATURE);
    let result = timeout(
        WATCHDOG,
        run(
            &app,
            &fixture.path,
            options(),
            opts(&[("Hash", "32"), ("Elo", "5001"), ("Elo", "1900")]),
        ),
    )
    .await
    .unwrap();
    assert!(
        matches!(result, Err(Error::Io(ref e)) if e.kind() == std::io::ErrorKind::InvalidInput)
    );
    assert!(fixture.commands().is_empty());
    assert_eq!(fixture.state(), "1200,1300");
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn maia_conditioning_report_cancellation_preserves_conditioning_and_reaps() {
    let app = app();
    let fixture = MaiaFixture::new(SIGNATURE);
    fixture.stall_go();
    let report = run(
        &app,
        &fixture.path,
        options(),
        opts(&[("OppoElo", "2200"), ("Elo", "1800")]),
    );
    tokio::pin!(report);
    timeout(WATCHDOG, async {
        tokio::select! {
            result = &mut report => panic!("report unexpectedly finished: {result:?}"),
            () = fixture.phase() => {}
        }
        cancel_analysis(ID.into(), app.state()).await.unwrap();
        let result = timeout(CANCEL_DEADLINE, &mut report).await.unwrap();
        assert!(matches!(result, Err(Error::AnalysisCancelled)));
    })
    .await
    .unwrap();
    assert_eq!(fixture.state(), "1800,2200");
    assert_eq!(
        fixture.commands(),
        [
            "setoption name UCI_Chess960 value false",
            "setoption name MultiPV value 2",
            "setoption name SelfElo value 1800",
            "setoption name OppoElo value 2200"
        ]
    );
    assert!(app.state::<AppState>().analysis_cancel_flags.is_empty());
    fixture.assert_reaped();
}

#[tokio::test]
async fn maia_conditioning_chess960_position_delta_does_not_reemit_conditioning() {
    let fixture = MaiaFixture::new(SIGNATURE);
    let mut process = maia_process(&fixture).await;
    let mut request = maia_options(&[("MultiPV", "3"), ("Elo", "1800"), ("UCI_Chess960", "false")]);
    request.fen = "rkr5/pppppppp/8/8/8/8/PPPPPPPP/RKR5 w ACac - 0 1".into();
    process.set_options(request.clone()).await.unwrap();
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.state(), "1800,1800");
    assert_eq!(process.real_multipv, 3);
    assert_eq!(
        fixture.commands(),
        [
            "setoption name UCI_Chess960 value true",
            "setoption name MultiPV value 3",
            "setoption name SelfElo value 1800",
            "setoption name OppoElo value 1800"
        ]
    );
    request.fen = FEN.into();
    process.set_options(request.clone()).await.unwrap();
    fixture.sync(&mut process.base).await;
    assert_eq!(fixture.state(), "1800,1800");
    assert_eq!(fixture.commands().len(), 5);
    assert_eq!(
        fixture.commands().last().unwrap(),
        "setoption name UCI_Chess960 value false"
    );
    assert_eq!(process.options, request);
    process.base.terminate_report().await.unwrap();
    fixture.assert_reaped();
}

use std::{
    fmt::Display,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use derivative::Derivative;
use governor::{Quota, RateLimiter};
use log::{info, warn};
use nonzero_ext::*;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, ByColor, CastlingMode, Chess, Color, EnPassantMode,
    Position, Role,
};
use specta::Type;
use tauri_specta::Event;
use tokio::sync::Mutex;
use vampirc_uci::{
    parse_one,
    uci::{Score, ScoreValue},
    UciInfoAttribute, UciMessage, UciOptionConfig,
};

use crate::{
    db::{is_position_in_db, GameQuery, PositionQueryJs},
    engine::{
        parse_fen_and_apply_moves, BaseEngine, EngineLog, EngineOption, EngineReader, GoMode,
    },
    error::Error,
    progress::update_progress,
    AppState,
};

#[cfg(test)]
mod evaluation_terminal_tests;

#[cfg(test)]
mod evaluation_qsearch_tests;

#[cfg(all(test, unix))]
mod report_lifecycle_tests;

pub struct EngineProcess {
    base: BaseEngine,
    last_depth: u32,
    best_moves: Vec<BestMoves>,
    last_best_moves: Vec<BestMoves>,
    last_progress: f32,
    options: EngineOptions,
    emitted_options: Option<Vec<EngineOption>>,
    go_mode: GoMode,
    running: bool,
    real_multipv: u16,
    start: Instant,
}

impl EngineProcess {
    async fn new(path: PathBuf) -> Result<(Self, EngineReader), Error> {
        let mut base = BaseEngine::spawn(path).await?;
        base.init_uci().await?;
        let mut process = Self::from_base(base);
        process.ensure_objective_analysis().await?;
        let reader = process
            .base
            .take_reader()
            .ok_or(Error::EngineDisconnected)?;

        Ok((process, reader))
    }

    async fn ensure_objective_analysis(&mut self) -> Result<(), Error> {
        if let Err(primary) = self.base.ensure_objective_analysis() {
            if let Err(cleanup) = self.base.terminate_report().await {
                return Err(std::io::Error::other(format!(
                    "{primary} Engine termination/reap failed: {cleanup}"
                ))
                .into());
            }
            return Err(primary);
        }
        Ok(())
    }

    fn from_base(base: BaseEngine) -> Self {
        Self {
            base,
            last_depth: 0,
            best_moves: Vec::new(),
            last_best_moves: Vec::new(),
            last_progress: 0.0,
            options: EngineOptions::default(),
            emitted_options: None,
            real_multipv: 0,
            go_mode: GoMode::Infinite,
            running: false,
            start: Instant::now(),
        }
    }

    async fn set_option<T>(&mut self, name: &str, value: T) -> Result<(), Error>
    where
        T: Display,
    {
        self.base.set_option(name, value).await
    }

    async fn set_options(&mut self, options: EngineOptions) -> Result<(), Error> {
        let normalized = self.base.normalize_conditioning(&options.extra_options)?;
        let fen_changed = options.fen != self.options.fen;
        let fen: Fen = options.fen.parse()?;
        let setup = fen.as_setup();
        let castling_mode = CastlingMode::detect(setup);
        let pos = parse_fen_and_apply_moves(&options.fen, &options.moves)?;

        // A partial write must not leave a trusted effective-options cache.
        // Keep the raw request separately for get_best_moves' equality fast path.
        let previous_emitted = self.emitted_options.take();

        if fen_changed {
            if castling_mode.is_chess960() {
                self.set_option("UCI_Chess960", "true").await?;
            } else {
                self.set_option("UCI_Chess960", "false").await?;
            }
        }

        let multipv = options
            .extra_options
            .iter()
            .find(|x| x.name == "MultiPV")
            .map(|x| x.value.parse().unwrap_or(1))
            .unwrap_or(1);

        self.real_multipv = multipv.min(pos.legal_moves().len() as u16);

        let effective = normalized.as_ref().unwrap_or(&options.extra_options);
        for option in effective {
            let unchanged = if normalized.is_some() {
                previous_emitted
                    .as_deref()
                    .unwrap_or_default()
                    .contains(option)
            } else {
                self.options.extra_options.contains(option)
            };
            if !unchanged && option.name != "UCI_Chess960" {
                self.set_option(&option.name, &option.value).await?;
            }
        }

        if fen_changed || options.moves != self.options.moves {
            self.set_position(&options.fen, &options.moves).await?;
        }
        self.last_depth = 0;
        self.options = options.clone();
        self.emitted_options = normalized;
        self.best_moves.clear();
        self.last_best_moves.clear();
        Ok(())
    }

    async fn set_position(&mut self, fen: &str, moves: &[String]) -> Result<(), Error> {
        self.base.set_position(fen, moves).await?;
        self.options.fen = fen.to_string();
        self.options.moves = moves.to_owned();
        Ok(())
    }

    async fn go(&mut self, mode: &GoMode) -> Result<(), Error> {
        self.go_mode = mode.clone();
        self.base.go(mode).await?;
        self.running = true;
        self.start = Instant::now();
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), Error> {
        self.base.stop().await?;
        self.running = false;
        Ok(())
    }

    async fn kill(&mut self) -> Result<(), Error> {
        self.base.quit().await?;
        self.running = false;
        Ok(())
    }

    pub fn kill_sync(&mut self) {
        self.base.kill_sync();
    }
}

#[derive(Clone, Serialize, Debug, Derivative, Type)]
#[derivative(Default)]
pub struct BestMoves {
    nodes: u32,
    depth: u32,
    score: Score,
    #[serde(rename = "uciMoves")]
    uci_moves: Vec<String>,
    #[serde(rename = "sanMoves")]
    san_moves: Vec<String>,
    #[derivative(Default(value = "1"))]
    multipv: u16,
    nps: u32,
}

#[derive(Serialize, Debug, Clone, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct BestMovesPayload {
    pub best_lines: Vec<BestMoves>,
    pub engine: String,
    pub tab: String,
    pub fen: String,
    pub moves: Vec<String>,
    pub progress: f64,
}

fn invert_score(score: Score) -> Score {
    let new_value = match score.value {
        ScoreValue::Cp(x) => ScoreValue::Cp(-x),
        ScoreValue::Mate(x) => ScoreValue::Mate(-x),
    };
    let new_wdl = score.wdl.map(|(w, d, l)| (l, d, w));
    Score {
        value: new_value,
        wdl: new_wdl,
        ..score
    }
}

fn parse_uci_attrs(
    attrs: Vec<UciInfoAttribute>,
    fen: &Fen,
    moves: &[String],
) -> Result<BestMoves, Error> {
    let mut best_moves = BestMoves::default();

    let mut pos = parse_fen_and_apply_moves(&fen.to_string(), moves)?;
    let turn = pos.turn();

    for a in attrs {
        match a {
            UciInfoAttribute::Pv(m) => {
                for mv in m {
                    let uci: UciMove = mv.to_string().parse()?;
                    let m = uci.to_move(&pos)?;
                    let san = SanPlus::from_move_and_play_unchecked(&mut pos, &m);
                    best_moves.san_moves.push(san.to_string());
                    best_moves.uci_moves.push(uci.to_string());
                }
            }
            UciInfoAttribute::Nps(nps) => {
                best_moves.nps = nps as u32;
            }
            UciInfoAttribute::Nodes(nodes) => {
                best_moves.nodes = nodes as u32;
            }
            UciInfoAttribute::Depth(depth) => {
                best_moves.depth = depth;
            }
            UciInfoAttribute::MultiPv(multipv) => {
                best_moves.multipv = multipv;
            }
            UciInfoAttribute::Score(score) => {
                best_moves.score = score;
            }
            _ => (),
        }
    }

    if best_moves.san_moves.is_empty() {
        return Err(Error::NoMovesFound);
    }

    if turn == Color::Black {
        best_moves.score = invert_score(best_moves.score);
    }

    Ok(best_moves)
}

#[derive(Deserialize, Debug, Clone, Type, Derivative, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
#[derivative(Default)]
pub struct EngineOptions {
    pub fen: String,
    pub moves: Vec<String>,
    pub extra_options: Vec<EngineOption>,
}

#[tauri::command]
#[specta::specta]
pub async fn kill_engines(tab: String, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    let keys: Vec<_> = state
        .engine_processes
        .iter()
        .map(|x| x.key().clone())
        .collect();
    for key in keys.clone() {
        if key.0.starts_with(&tab) {
            {
                let process = state.engine_processes.get_mut(&key).unwrap();
                let mut process = process.lock().await;
                process.kill().await?;
            }
            state.engine_processes.remove(&key);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn kill_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let mut process = process.lock().await;
        process.kill().await?;
    }
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn stop_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let mut process = process.lock().await;
        process.stop().await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_logs(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EngineLog>, Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let process = process.lock().await;
        Ok(process.base.get_logs())
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_best_moves(
    id: String,
    engine: String,
    tab: String,
    go_mode: GoMode,
    options: EngineOptions,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
    get_best_moves_inner(id, engine, tab, go_mode, options, app, state).await
}

async fn get_best_moves_inner<R: tauri::Runtime>(
    id: String,
    engine: String,
    tab: String,
    go_mode: GoMode,
    options: EngineOptions,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
    let path = PathBuf::from(&engine);

    let key = (tab.clone(), id.clone());

    if state.engine_processes.contains_key(&key) {
        {
            let entry = state.engine_processes.get_mut(&key).unwrap();
            let mut process = entry.lock().await;
            if let Err(error) = process.ensure_objective_analysis().await {
                let rejected = entry.value().clone();
                drop(process);
                drop(entry);
                state
                    .engine_processes
                    .remove_if(&key, |_, current| Arc::ptr_eq(current, &rejected));
                return Err(error);
            }
            if options == process.options && go_mode == process.go_mode && process.running {
                return Ok(Some((
                    process.last_progress,
                    process.last_best_moves.clone(),
                )));
            }
            process.stop().await?;
        }
        // give time for engine to stop and process previous lines
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        {
            let process = state.engine_processes.get_mut(&key).unwrap();
            let mut process = process.lock().await;
            process.set_options(options.clone()).await?;
            process.go(&go_mode).await?;
        }
        return Ok(None);
    }

    let (mut process, mut reader) = EngineProcess::new(path).await?;
    process.set_options(options.clone()).await?;
    process.go(&go_mode).await?;

    let process = Arc::new(Mutex::new(process));

    state.engine_processes.insert(key.clone(), process.clone());

    let lim = RateLimiter::direct(Quota::per_second(nonzero!(5u32)));

    while let Some(line) = reader.next_line().await? {
        let mut proc = process.lock().await;
        match parse_one(&line) {
            UciMessage::Info(attrs) => {
                match parse_uci_attrs(attrs, &proc.options.fen.parse()?, &proc.options.moves) {
                    Ok(best_moves) => {
                        if best_moves.score.lower_bound == Some(true)
                            || best_moves.score.upper_bound == Some(true)
                        {
                            continue;
                        }
                        let multipv = best_moves.multipv;
                        let cur_depth = best_moves.depth;
                        let cur_nodes = best_moves.nodes;
                        if multipv as usize == proc.best_moves.len() + 1 {
                            proc.best_moves.push(best_moves);
                            if multipv == proc.real_multipv {
                                if proc.best_moves.iter().all(|x| x.depth == cur_depth)
                                    && cur_depth >= proc.last_depth
                                    && lim.check().is_ok()
                                {
                                    let progress = match proc.go_mode {
                                        GoMode::Depth(depth) => {
                                            (cur_depth as f64 / depth as f64) * 100.0
                                        }
                                        GoMode::Time(time) => {
                                            (proc.start.elapsed().as_millis() as f64 / time as f64)
                                                * 100.0
                                        }
                                        GoMode::Nodes(nodes) => {
                                            (cur_nodes as f64 / nodes as f64) * 100.0
                                        }
                                        GoMode::PlayersTime(_) => 99.99,
                                        GoMode::Infinite => 99.99,
                                    };
                                    BestMovesPayload {
                                        best_lines: proc.best_moves.clone(),
                                        engine: id.clone(),
                                        tab: tab.clone(),
                                        fen: proc.options.fen.clone(),
                                        moves: proc.options.moves.clone(),
                                        progress,
                                    }
                                    .emit(&app)?;
                                    proc.last_depth = cur_depth;
                                    proc.last_best_moves = proc.best_moves.clone();
                                    proc.last_progress = progress as f32;
                                }
                                proc.best_moves.clear();
                            }
                        }
                    }
                    Err(e) => match e {
                        Error::NoMovesFound => {}
                        _ => {
                            warn!("Failed to parse info line: {}, error: {:?}", line, e);
                        }
                    },
                }
            }
            UciMessage::BestMove { .. } => {
                BestMovesPayload {
                    best_lines: proc.last_best_moves.clone(),
                    engine: id.clone(),
                    tab: tab.clone(),
                    fen: proc.options.fen.clone(),
                    moves: proc.options.moves.clone(),
                    progress: 100.0,
                }
                .emit(&app)?;
                proc.last_progress = 100.0;
            }
            _ => {}
        }
        proc.base.log_engine(&line);
    }
    info!("Engine process finished: tab: {}, engine: {}", tab, engine);
    state.engine_processes.remove(&key);
    Ok(None)
}

#[derive(Serialize, Debug, Default, Type)]
pub struct MoveAnalysis {
    best: Vec<BestMoves>,
    novelty: bool,
    is_sacrifice: bool,
}

#[derive(Deserialize, Debug, Default, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOptions {
    pub fen: String,
    pub moves: Vec<String>,
    pub annotate_novelties: bool,
    pub reference_db: Option<PathBuf>,
    pub reversed: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_analysis(id: String, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    if let Some(flag) = state.analysis_cancel_flags.get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

struct ReportRegistration<'a> {
    flags: &'a dashmap::DashMap<String, Arc<AtomicBool>>,
    id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for ReportRegistration<'_> {
    fn drop(&mut self) {
        self.flags
            .remove_if(&self.id, |_, flag| Arc::ptr_eq(flag, &self.flag));
    }
}

async fn report_cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn analyze_game(
    id: String,
    engine: String,
    go_mode: GoMode,
    options: AnalysisOptions,
    uci_options: Vec<EngineOption>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<MoveAnalysis>, Error> {
    analyze_game_inner(id, engine, go_mode, options, uci_options, state, app).await
}

async fn analyze_game_inner<R: tauri::Runtime>(
    id: String,
    engine: String,
    go_mode: GoMode,
    options: AnalysisOptions,
    uci_options: Vec<EngineOption>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<MoveAnalysis>, Error> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let replaced = state
        .analysis_cancel_flags
        .insert(id.clone(), cancel_flag.clone());
    let _registration = ReportRegistration {
        flags: &state.analysis_cancel_flags,
        id: id.clone(),
        flag: cancel_flag.clone(),
    };
    if let Some(previous) = replaced {
        previous.store(true, Ordering::SeqCst);
    }

    // Keep ownership outside the selected future, even while UCI initialization
    // or a pipe write is stalled, so cancellation can always terminate and reap.
    let mut proc = EngineProcess::from_base(BaseEngine::spawn(PathBuf::from(engine)).await?);
    let engine_work = async {
        proc.base.init_uci().await?;
        proc.base.ensure_objective_analysis()?;
        let mut reader = proc.base.take_reader().ok_or(Error::EngineDisconnected)?;
        let mut analysis: Vec<MoveAnalysis> = Vec::new();

        let fen = Fen::from_ascii(options.fen.as_bytes())?;
        let setup = fen.as_setup().clone();
        let castling_mode = CastlingMode::detect(&setup);

        let mut chess: Chess = setup.position(castling_mode)?;
        let mut fens: Vec<(Fen, Vec<String>, bool)> = vec![(fen, vec![], false)];

        for (i, m) in options.moves.iter().enumerate() {
            tokio::task::yield_now().await;
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(Error::AnalysisCancelled);
            }

            let uci = UciMove::from_ascii(m.as_bytes())?;
            let m = uci.to_move(&chess)?;
            let previous_pos = chess.clone();
            chess.play_unchecked(&m);
            let current_pos = chess.clone();
            if !chess.is_game_over() {
                let is_sacrifice = is_material_sacrifice(
                    &previous_pos,
                    &current_pos,
                    &mut EvaluationBudget::default(),
                );
                fens.push((
                    Fen::from_position(current_pos, EnPassantMode::Legal),
                    options.moves.clone().into_iter().take(i + 1).collect(),
                    is_sacrifice,
                ));
            }
            #[cfg(all(test, unix))]
            report_lifecycle_tests::record_completed_ply();
        }

        if options.reversed {
            fens.reverse();
        }

        for (i, (_, moves, _)) in fens.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(Error::AnalysisCancelled);
            }

            update_progress(
                &state.progress_state,
                &app,
                id.clone(),
                (i as f32 / fens.len() as f32) * 100.0,
                false,
            )?;

            let mut extra_options = uci_options.clone();
            if !extra_options.iter().any(|x| x.name == "MultiPV") {
                extra_options.push(EngineOption {
                    name: "MultiPV".to_string(),
                    value: "2".to_string(),
                });
            } else {
                extra_options.iter_mut().for_each(|x| {
                    if x.name == "MultiPV" {
                        x.value = "2".to_string();
                    }
                });
            }

            proc.set_options(EngineOptions {
                fen: options.fen.clone(),
                moves: moves.clone(),
                extra_options,
            })
            .await?;

            proc.go(&go_mode).await?;

            let mut current_analysis = MoveAnalysis::default();
            loop {
                let line = reader.next_line().await?.ok_or(Error::EngineDisconnected)?;
                match parse_one(&line) {
                    UciMessage::Info(attrs) => {
                        if let Ok(best_moves) =
                            parse_uci_attrs(attrs, &proc.options.fen.parse()?, moves)
                        {
                            let multipv = best_moves.multipv;
                            let cur_depth = best_moves.depth;
                            if multipv as usize == proc.best_moves.len() + 1 {
                                proc.best_moves.push(best_moves);
                                if multipv == proc.real_multipv {
                                    if proc.best_moves.iter().all(|x| x.depth == cur_depth)
                                        && cur_depth >= proc.last_depth
                                    {
                                        current_analysis.best = proc.best_moves.clone();
                                        proc.last_depth = cur_depth;
                                    }
                                    assert_eq!(proc.best_moves.len(), proc.real_multipv as usize);
                                    proc.best_moves.clear();
                                }
                            }
                        }
                    }
                    UciMessage::BestMove { .. } => {
                        break;
                    }
                    _ => {}
                }
            }
            analysis.push(current_analysis);
        }
        Ok((analysis, fens))
    };
    let engine_result = tokio::select! {
        biased;
        () = report_cancelled(&cancel_flag) => Err(Error::AnalysisCancelled),
        result = engine_work => result,
    };

    // Cleanup is deliberately outside cancellation selection. A kill request
    // alone is not a reap, and neither normal completion nor an error skips it.
    let cleanup_result = proc.base.terminate_report().await;
    if let Err(cleanup) = cleanup_result {
        let context = match engine_result {
            Err(primary) => {
                format!("Report failed: {primary}. Engine termination/reap failed: {cleanup}")
            }
            Ok(_) => format!("Engine termination/reap failed: {cleanup}"),
        };
        return Err(std::io::Error::other(context).into());
    }
    let (mut analysis, mut fens) = engine_result?;

    let annotations = async {
        if options.reversed {
            analysis.reverse();
            fens.reverse();
        }

        let mut novelty_found = false;
        for (i, analysis) in analysis.iter_mut().enumerate() {
            let fen = &fens[i].0;
            // let query = PositionQuery::exact_from_fen(&fen.to_string())?;
            let query = PositionQueryJs {
                fen: fen.to_string(),
                type_: "exact".to_string(),
            };

            analysis.is_sacrifice = fens[i].2;
            if options.annotate_novelties && !novelty_found {
                if let Some(reference) = options.reference_db.clone() {
                    analysis.novelty = !is_position_in_db(
                        reference,
                        GameQuery::new().position(query.clone()).clone(),
                        state.clone(),
                    )
                    .await?;
                    if analysis.novelty {
                        novelty_found = true;
                    }
                } else {
                    return Err(Error::MissingReferenceDatabase);
                }
            }
        }
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(Error::AnalysisCancelled);
        }
        update_progress(&state.progress_state, &app, id.clone(), 100.0, true)?;
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(Error::AnalysisCancelled);
        }
        Ok(analysis)
    };
    tokio::select! {
        biased;
        () = report_cancelled(&cancel_flag) => Err(Error::AnalysisCancelled),
        result = annotations => result,
    }
}

fn count_material(position: &Chess) -> i32 {
    if position.is_checkmate() {
        return -10000;
    }
    if position.is_stalemate() {
        return 0;
    }
    let material: ByColor<i32> = position.board().material().map(|p| {
        p.pawn as i32 * piece_value(Role::Pawn)
            + p.knight as i32 * piece_value(Role::Knight)
            + p.bishop as i32 * piece_value(Role::Bishop)
            + p.rook as i32 * piece_value(Role::Rook)
            + p.queen as i32 * piece_value(Role::Queen)
    });
    if position.turn() == Color::White {
        material.white - material.black
    } else {
        material.black - material.white
    }
}

fn piece_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 90,
        Role::Knight => 300,
        Role::Bishop => 300,
        Role::Rook => 500,
        Role::Queen => 1000,
        _ => 0,
    }
}

// Operational bounds, not chess draw rules. One budget covers every root sibling
// and both evaluations used for a sacrifice decision. A terminal position is
// resolved even at a limit, but no nonterminal node expands after exhaustion.
// Terminal-first boundary probes can exceed the node allowance, without adding
// descendants. The ply limit also bounds the pending sibling lists on the stack.
// Initial 10k/64 policy completes the existing fixtures while limiting synchronous
// report work. Neither limit is evidence of a draw or a correct full chess score.
const EVALUATION_NODE_LIMIT: usize = 10_000;
const EVALUATION_PLY_LIMIT: usize = 64;

struct EvaluationBudget {
    remaining_nodes: usize,
    max_ply: usize,
    #[cfg(test)]
    visited_nodes: usize,
    #[cfg(test)]
    deepest_ply: usize,
}

impl EvaluationBudget {
    fn new(nodes: usize, max_ply: usize) -> Self {
        Self {
            remaining_nodes: nodes,
            max_ply,
            #[cfg(test)]
            visited_nodes: 0,
            #[cfg(test)]
            deepest_ply: 0,
        }
    }

    fn visit(&mut self, ply: usize) -> bool {
        #[cfg(test)]
        {
            self.visited_nodes += 1;
            self.deepest_ply = self.deepest_ply.max(ply);
        }
        let available = self.remaining_nodes > 0 && ply < self.max_ply;
        self.remaining_nodes = self.remaining_nodes.saturating_sub(1);
        available
    }
}

impl Default for EvaluationBudget {
    fn default() -> Self {
        Self::new(EVALUATION_NODE_LIMIT, EVALUATION_PLY_LIMIT)
    }
}

// None means the operational budget was exhausted, never a guessed score.
// Scores are fail-hard bounds for this restricted search, not full chess values.
fn qsearch_complete(
    position: &Chess,
    mut alpha: i32,
    beta: i32,
    budget: &mut EvaluationBudget,
    ply: usize,
) -> Option<i32> {
    // Normalize MIN before any negation, including recursive child windows.
    alpha = alpha.max(-i32::MAX);
    let beta = beta.max(-i32::MAX);
    debug_assert!(alpha <= beta);
    let legal_moves = position.legal_moves();
    let checked = position.is_check();
    let available = budget.visit(ply);
    if legal_moves.is_empty() {
        return Some((if checked { -10000 } else { 0 }).clamp(alpha, beta));
    }
    if !available {
        return None;
    }

    if !checked {
        let stand_pat = count_material(position);
        if stand_pat >= beta {
            return Some(beta);
        }
        alpha = alpha.max(stand_pat);
    }
    // Quiet moves are included only when they evade check. Captures retain the
    // existing descending victim-value ordering, with quiet evasions last.
    let mut moves: Vec<_> = legal_moves
        .iter()
        .filter(|mv| checked || mv.is_capture())
        .collect();
    moves.sort_by_key(|mv| -mv.capture().map(piece_value).unwrap_or(0));

    for mv in moves {
        let mut child = position.clone();
        child.play_unchecked(mv);
        let score = -qsearch_complete(&child, -beta, -alpha, budget, ply + 1)?;
        if score >= beta {
            return Some(beta);
        }
        alpha = alpha.max(score);
    }
    Some(alpha)
}

fn naive_eval_complete(pos: &Chess, budget: &mut EvaluationBudget) -> Option<i32> {
    let moves = pos.legal_moves();
    let available = budget.visit(0);
    if moves.is_empty() {
        return Some(if pos.is_check() { -10000 } else { 0 });
    }
    if !available {
        return None;
    }
    let mut best = -i32::MAX;
    for mv in &moves {
        let mut child = pos.clone();
        child.play_unchecked(mv);
        best = best.max(-qsearch_complete(&child, -i32::MAX, i32::MAX, budget, 1)?);
    }
    Some(best)
}

fn is_material_sacrifice(previous: &Chess, current: &Chess, budget: &mut EvaluationBudget) -> bool {
    let Some(previous_eval) = naive_eval_complete(previous, budget) else {
        return false;
    };
    let Some(current_eval) = naive_eval_complete(current, budget) else {
        return false;
    };
    // Equivalent to previous_eval > -current_eval + 100, without overflow.
    i64::from(previous_eval) + i64::from(current_eval) > 100
}

// Exercise the production algorithm with the default operational budget.
#[cfg(test)]
fn qsearch(position: &Chess, alpha: i32, beta: i32) -> i32 {
    qsearch_complete(position, alpha, beta, &mut EvaluationBudget::default(), 0)
        .expect("qsearch evaluation incomplete")
}

#[cfg(test)]
fn naive_eval(pos: &Chess) -> i32 {
    naive_eval_complete(pos, &mut EvaluationBudget::default()).expect("root evaluation incomplete")
}

#[cfg(test)]
mod tests {
    use shakmaty::FromSetup;

    use super::*;

    fn pos(fen: &str) -> Chess {
        let fen: Fen = fen.parse().unwrap();
        Chess::from_setup(fen.into_setup(), CastlingMode::Chess960).unwrap()
    }

    fn after_line(position: &Chess, moves: &[&str]) -> Chess {
        let mut child = position.clone();
        for uci in moves {
            let mv = uci.parse::<UciMove>().unwrap().to_move(&child).unwrap();
            child.play_unchecked(&mv);
        }
        child
    }

    #[test]
    fn eval_start_pos() {
        assert_eq!(naive_eval(&Chess::default()), 0);
    }

    #[test]
    fn eval_scandi() {
        let position = pos("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
        assert_eq!(naive_eval(&position), 0);
    }

    #[test]
    fn eval_hanging_pawn() {
        let position = pos("r1bqkbnr/ppp1pppp/2n5/1B1p4/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3");
        // ...dxe4 wins one pawn, valued at 90 rather than 100.
        let child = after_line(&position, &["d5e4"]);
        assert_eq!(count_material(&child), -90);
        assert_eq!(naive_eval(&position), 90);
    }

    #[test]
    fn eval_complex_center() {
        let position = pos("r1bqkbnr/ppp2ppp/2n5/1B1pp3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4");
        // Bxc6+ bxc6 Nxe5 leaves White a pawn ahead.
        let child = after_line(&position, &["b5c6", "b7c6", "f3e5"]);
        assert_eq!(count_material(&child), -90);
        assert_eq!(naive_eval(&position), 90);
    }

    #[test]
    fn eval_in_check() {
        let position = pos("r1bqkbnr/ppp2ppp/2B5/3pp3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4");
        let child = after_line(&position, &["b7c6", "f3e5"]);
        assert_eq!(count_material(&child), -90);
        assert_eq!(naive_eval(&position), -90);
    }

    #[test]
    fn eval_rook_stack() {
        let position = pos("rnrq4/8/8/1R6/1R6/1R5K/1Q6/7k w - - 0 1");
        // Qb1+ Rc1 Qxc1+ Qd1 Qxd1#. Checked nodes must search blocks,
        // not stand pat at a material score. This is one legal mating line.
        let child = after_line(&position, &["b2b1", "c8c1", "b1c1", "d8d1", "c1d1"]);
        assert!(child.is_checkmate());
        assert_eq!(naive_eval(&position), 10000);
    }

    #[test]
    fn eval_rook_stack2() {
        let position = pos("rnrq4/8/8/1R6/1Q6/1R5K/1R6/7k w - - 0 1");
        // The same line mates with Rb1+ instead of Qb1+.
        let child = after_line(&position, &["b2b1", "c8c1", "b1c1", "d8d1", "c1d1"]);
        assert!(child.is_checkmate());
        assert_eq!(naive_eval(&position), 10000);
    }

    #[test]
    fn eval_opera_game1() {
        let position = pos("4kb1r/p2rqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2K4R w k - 0 14");
        // Bxd7+ Qxd7: White has two extra pawns against a knight.
        let expected = 2 * 90 - 300;
        let child = after_line(&position, &["b5d7", "e7d7"]);
        assert_eq!(count_material(&child), expected);
        assert_eq!(naive_eval(&position), expected);
    }

    #[test]
    fn eval_opera_game2() {
        let position = pos("4kb1r/p2rqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2KR4 b k - 1 14");
        // ...Qb4 Qxb4 Bxb4 Bxf6: Black has an extra rook against a
        // bishop and two pawns. This is a restricted-search material score,
        // not a claim that the Opera Game is equal under full engine search.
        let expected = 500 - 300 - 2 * 90;
        let child = after_line(&position, &["e7b4", "b3b4", "f8b4", "g5f6"]);
        assert_eq!(count_material(&child), expected);
        assert_eq!(naive_eval(&position), expected);
    }
}

#[derive(Type, Default, Serialize, Debug)]
pub struct EngineConfig {
    pub name: String,
    pub options: Vec<UciOptionConfig>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_config(path: PathBuf) -> Result<EngineConfig, Error> {
    let mut base = BaseEngine::spawn(path).await?;

    base.send("uci").await?;

    let mut config = EngineConfig::default();

    let reader = base.reader_mut().ok_or(Error::EngineDisconnected)?;
    while let Some(line) = reader.next_line().await? {
        if let UciMessage::Id {
            name: Some(name),
            author: _,
        } = parse_one(&line)
        {
            config.name = name;
        }
        if let UciMessage::Option(opt) = parse_one(&line) {
            config.options.push(opt);
        }
        if let UciMessage::UciOk = parse_one(&line) {
            break;
        }
    }
    println!("{:?}", config);
    base.quit().await?;
    Ok(config)
}

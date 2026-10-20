use super::*;

// The checked side has a queen against a rook, but must move its king and
// expose the queen to a capture. The best legal evasion scores 0, not +500.
const QUIET_EVASIONS: [&str; 2] = [
    "4q3/4k3/8/8/8/8/4R3/K7 b - - 1 1",
    "k7/4r3/8/8/8/8/4K3/4Q3 w - - 1 1",
];

fn position(fen: &str) -> Chess {
    fen.parse::<Fen>()
        .unwrap()
        .into_position(CastlingMode::Standard)
        .unwrap()
}

#[test]
fn checked_quiet_evasions_replace_stand_pat_for_both_colors() {
    for fen in QUIET_EVASIONS {
        let pos = position(fen);
        assert!(pos.is_check());
        assert_eq!(pos.legal_moves().len(), 6);
        assert!(pos.legal_moves().iter().all(|mv| !mv.is_capture()));
        assert_eq!(count_material(&pos), 500);
        assert_eq!(qsearch(&pos, -i32::MAX, i32::MAX), 0, "{fen}");
    }
}

#[test]
fn checked_stand_pat_cannot_trigger_a_beta_cutoff() {
    for fen in QUIET_EVASIONS {
        assert_eq!(qsearch(&position(fen), -i32::MAX, 400), 0, "{fen}");
    }
}

#[test]
fn checked_root_already_searches_evasions() {
    for fen in QUIET_EVASIONS {
        assert_eq!(naive_eval(&position(fen)), 0, "{fen}");
    }
}

#[test]
fn checked_search_retains_fail_hard_bounds() {
    for fen in QUIET_EVASIONS {
        let pos = position(fen);
        assert_eq!(qsearch(&pos, -100, -1), -1, "fail high: {fen}");
        assert_eq!(qsearch(&pos, 1, 100), 1, "fail low: {fen}");
    }
}

// Moving the checked white king off the e-file uncovers Re1+, so a quiet
// evasion itself checks Black. This is a legal countercheck, not a repetition
// fixture or evidence that the restricted search solves perpetual check.
const COUNTERCHECK: &str = "4k3/8/8/8/8/8/r3K3/4R3 w - - 0 1";

// Disposable deterministic legal-play fixtures, not game-history/draw claims.
// Nc6+ and Nd7+ interpose against Bb5+ while uncovering Qb8 against Kf4.
const COUNTERCHECK_STRESS: &str =
    "rq2k3/8/b3p1rp/pB1pnp2/3pPK1P/bP1Q2P1/P1P2P2/RNBn2NR b q - 15 32";
const NODE_STRESS: &str = "2rqk2r/n1pp1p1p/2b2nPp/pp2p3/Pb1P4/NR6/2P1PP1R/1NBQK2B w - - 0 22";

const EXISTING_FIXTURES: [(&str, &str); 9] = [
    (
        "start",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    ),
    (
        "scandi",
        "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    ),
    (
        "hanging_pawn",
        "r1bqkbnr/ppp1pppp/2n5/1B1p4/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    ),
    (
        "complex_center",
        "r1bqkbnr/ppp2ppp/2n5/1B1pp3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4",
    ),
    (
        "in_check",
        "r1bqkbnr/ppp2ppp/2B5/3pp3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4",
    ),
    ("rook_stack", "rnrq4/8/8/1R6/1R6/1R5K/1Q6/7k w - - 0 1"),
    ("rook_stack2", "rnrq4/8/8/1R6/1Q6/1R5K/1R6/7k w - - 0 1"),
    (
        "opera1",
        "4kb1r/p2rqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2K4R w k - 0 14",
    ),
    (
        "opera2",
        "4kb1r/p2rqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2KR4 b k - 1 14",
    ),
];

fn after(pos: &Chess, uci: &str) -> Chess {
    let mv = uci.parse::<UciMove>().unwrap().to_move(pos).unwrap();
    let mut child = pos.clone();
    child.play_unchecked(&mv);
    child
}

fn bounded_qsearch(pos: &Chess, nodes: usize, plies: usize) -> Option<i32> {
    qsearch_complete(
        pos,
        -i32::MAX,
        i32::MAX,
        &mut EvaluationBudget::new(nodes, plies),
        0,
    )
}

#[test]
fn checked_capture_evasion_is_searched() {
    // Black can capture the checking rook with Ke7xe6 instead of losing its
    // queen after a quiet king move. The king capture must remain in search.
    let pos = position("4q3/4k3/4R3/8/8/8/8/K7 b - - 0 1");
    assert!(pos.is_check());
    assert!(pos.legal_moves().iter().any(|mv| mv.is_capture()));
    assert!(pos.legal_moves().iter().any(|mv| !mv.is_capture()));
    assert_eq!(count_material(&pos), 500);
    assert_eq!(bounded_qsearch(&pos, 10_000, 64), Some(1000));
}

#[test]
fn unchecked_search_keeps_capture_only_policy_and_pawn_value() {
    let pos = position("7k/P7/8/8/8/8/8/K7 w - - 0 1");
    assert!(!pos.is_check());
    assert!(pos.legal_moves().iter().any(|mv| mv.promotion().is_some()));
    assert!(pos.legal_moves().iter().all(|mv| !mv.is_capture()));
    assert_eq!(bounded_qsearch(&pos, 1, 1), Some(90));
    assert_eq!(piece_value(Role::Pawn), 90);
    assert_eq!(qsearch(&pos, -100, 80), 80);
    assert_eq!(qsearch(&pos, 100, 200), 100);
}

#[test]
fn min_windows_are_normalized_before_recursive_negation() {
    for fen in QUIET_EVASIONS.into_iter().chain([COUNTERCHECK]) {
        let pos = position(fen);
        assert_eq!(qsearch(&pos, i32::MIN, i32::MAX), 0);
        assert_eq!(qsearch(&pos, i32::MIN, -i32::MAX), -i32::MAX);
    }
}

#[test]
fn terminal_resolution_precedes_zero_node_and_ply_limits() {
    for (fen, score) in [
        ("8/8/8/8/8/6k1/6q1/7K w - - 0 1", -10000),
        ("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1", -10000),
        ("8/8/8/8/8/6k1/5q2/7K w - - 0 1", 0),
        ("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", 0),
    ] {
        let pos = position(fen);
        assert_eq!(bounded_qsearch(&pos, 0, 0), Some(score));
        assert_eq!(
            naive_eval_complete(&pos, &mut EvaluationBudget::new(0, 0)),
            Some(score)
        );
        for (alpha, beta) in [(-10001, -10000), (-500, 500), (-20000, -15000)] {
            assert_eq!(
                qsearch_complete(&pos, alpha, beta, &mut EvaluationBudget::new(0, 0), 0),
                Some(score.clamp(alpha, beta))
            );
        }
    }
}

#[test]
fn terminal_child_at_ply_boundary_still_resolves() {
    let pos = position("7k/8/5KQ1/8/8/8/8/8 w - - 0 1");
    let mate = after(&pos, "g6g7");
    assert!(mate.is_checkmate());
    let mut budget = EvaluationBudget::new(1, 1);
    assert!(budget.visit(0));
    assert_eq!(
        qsearch_complete(&mate, -i32::MAX, i32::MAX, &mut budget, 1),
        Some(-10000)
    );
    assert_eq!(budget.remaining_nodes, 0);
}

#[test]
fn tiny_budgets_return_incomplete_not_stand_pat_or_draw() {
    for fen in [QUIET_EVASIONS[0], COUNTERCHECK, EXISTING_FIXTURES[0].1] {
        let pos = position(fen);
        assert_eq!(bounded_qsearch(&pos, 0, 64), None);
        assert_eq!(bounded_qsearch(&pos, 10_000, 0), None);
        assert_eq!(
            naive_eval_complete(&pos, &mut EvaluationBudget::new(1, 64)),
            None
        );
    }
    for fen in QUIET_EVASIONS {
        let pos = position(fen);
        assert_eq!(bounded_qsearch(&pos, 1, 64), None);
        assert_eq!(bounded_qsearch(&pos, 10_000, 1), None);
        // Even a window that previously accepted +500 stand-pat must search.
        assert_eq!(
            qsearch_complete(&pos, -1000, 400, &mut EvaluationBudget::new(1, 64), 0),
            None
        );
    }
}

#[test]
fn countercheck_evasion_is_legal_and_search_is_bounded() {
    let pos = position(COUNTERCHECK);
    assert!(pos.is_check());
    let mv = "e2d3".parse::<UciMove>().unwrap().to_move(&pos).unwrap();
    assert!(!mv.is_capture());
    let child = after(&pos, "e2d3");
    assert!(child.is_check());
    assert!(!child.is_checkmate());
    let mut budget = EvaluationBudget::default();
    assert_eq!(
        qsearch_complete(&pos, -i32::MAX, i32::MAX, &mut budget, 0),
        Some(0)
    );
    assert!(budget.deepest_ply >= 2);
    assert_eq!(bounded_qsearch(&pos, 10_000, 1), None);
    assert_eq!(bounded_qsearch(&pos, 2, 64), None);
}

#[test]
fn root_siblings_share_one_node_budget() {
    let pos = Chess::default();
    assert_eq!(pos.legal_moves().len(), 20);
    let mut short = EvaluationBudget::new(20, 64);
    assert_eq!(naive_eval_complete(&pos, &mut short), None);
    assert_eq!(short.remaining_nodes, 0);
    assert_eq!(short.visited_nodes, 21);
    let mut exact = EvaluationBudget::new(21, 64);
    assert_eq!(naive_eval_complete(&pos, &mut exact), Some(0));
    assert_eq!(exact.remaining_nodes, 0);
    assert_eq!(exact.visited_nodes, 21);
}

#[test]
fn quiet_interposing_counterchecks_terminate_without_a_draw_shortcut() {
    let pos = position(COUNTERCHECK_STRESS);
    assert!(pos.is_check());
    for uci in ["e5c6", "e5d7"] {
        let mv = uci.parse::<UciMove>().unwrap().to_move(&pos).unwrap();
        assert!(!mv.is_capture());
        assert!(after(&pos, uci).is_check());
    }
    let mut budget = EvaluationBudget::default();
    assert_eq!(
        qsearch_complete(&pos, -i32::MAX, i32::MAX, &mut budget, 0),
        Some(300)
    );
    assert!(budget.deepest_ply >= 20);
    assert!(budget.visited_nodes > 1000);
    assert_eq!(bounded_qsearch(&pos, 10_000, 8), None);
}

#[test]
fn default_node_limit_stops_real_checked_search_deterministically() {
    let pos = position(NODE_STRESS);
    assert!(pos.is_check());
    for _ in 0..3 {
        let mut budget = EvaluationBudget::default();
        assert_eq!(
            qsearch_complete(&pos, -i32::MAX, i32::MAX, &mut budget, 0),
            None
        );
        assert_eq!(budget.remaining_nodes, 0);
        // One nonterminal boundary probe discovers exhaustion and unwinds.
        assert_eq!(budget.visited_nodes, EVALUATION_NODE_LIMIT + 1);
        assert!(budget.deepest_ply < EVALUATION_PLY_LIMIT);
    }
}

#[test]
fn sacrifice_requires_both_complete_evaluations_on_the_same_budget() {
    let previous = position("7r/8/7k/8/8/8/8/K2Q4 w - - 0 1");
    let current = after(&previous, "d1d8");
    let mut previous_budget = EvaluationBudget::default();
    let previous_eval = naive_eval_complete(&previous, &mut previous_budget).unwrap();
    let mut current_budget = EvaluationBudget::default();
    let current_eval = naive_eval_complete(&current, &mut current_budget).unwrap();
    assert!(previous_eval > -current_eval + 100);
    let previous_nodes = previous_budget.visited_nodes;
    let pair_nodes = previous_nodes + current_budget.visited_nodes;
    for nodes in [0, previous_nodes, pair_nodes - 1] {
        let mut budget = EvaluationBudget::new(nodes, 64);
        assert!(!is_material_sacrifice(&previous, &current, &mut budget));
        assert_eq!(budget.remaining_nodes, 0);
    }
    let mut budget = EvaluationBudget::new(pair_nodes, 64);
    assert!(is_material_sacrifice(&previous, &current, &mut budget));
    assert_eq!(budget.visited_nodes, pair_nodes);
    assert_eq!(budget.remaining_nodes, 0);
}

#[test]
fn complete_sacrifice_comparisons_retain_the_original_threshold_and_sign() {
    let previous = position("7r/8/7k/8/8/8/8/K2Q4 w - - 0 1");
    let mut found_sacrifice = false;
    let mut found_non_sacrifice = false;
    for mv in previous.legal_moves() {
        let mut current = previous.clone();
        current.play_unchecked(&mv);
        let expected = naive_eval(&previous) > -naive_eval(&current) + 100;
        assert_eq!(
            is_material_sacrifice(&previous, &current, &mut EvaluationBudget::default()),
            expected
        );
        found_sacrifice |= expected;
        found_non_sacrifice |= !expected;
    }
    assert!(found_sacrifice && found_non_sacrifice);
}

#[test]
fn measure_existing_and_disposable_fixtures_deterministically() {
    // Run with --nocapture for node counts and wall-clock timings. Timings are
    // observations only, never flaky pass/fail thresholds or chess truth.
    for (name, fen) in EXISTING_FIXTURES.into_iter().chain([
        ("quiet_black", QUIET_EVASIONS[0]),
        ("quiet_white", QUIET_EVASIONS[1]),
        ("countercheck", COUNTERCHECK),
        ("countercheck_stress", COUNTERCHECK_STRESS),
        ("node_stress", NODE_STRESS),
    ]) {
        let pos = position(fen);
        let mut reference = None;
        let mut elapsed = Vec::new();
        for _ in 0..5 {
            let mut budget = EvaluationBudget::default();
            let started = Instant::now();
            let score = naive_eval_complete(&pos, &mut budget);
            elapsed.push(started.elapsed().as_micros());
            let observation = (score, budget.visited_nodes, budget.deepest_ply);
            if let Some(reference) = reference {
                assert_eq!(observation, reference, "{name}");
            }
            reference = Some(observation);
        }
        elapsed.sort_unstable();
        println!(
            "root {name}: {:?}, us min/median/max={}/{}/{}",
            reference.unwrap(),
            elapsed[0],
            elapsed[2],
            elapsed[4]
        );
        let mv = pos.legal_moves()[0].clone();
        let mut current = pos.clone();
        current.play_unchecked(&mv);
        let mut budget = EvaluationBudget::default();
        let started = Instant::now();
        let sacrifice = is_material_sacrifice(&pos, &current, &mut budget);
        println!(
            "pair {name}: sacrifice={sacrifice}, visits={}, deepest={}, remaining={}, us={}",
            budget.visited_nodes,
            budget.deepest_ply,
            budget.remaining_nodes,
            started.elapsed().as_micros()
        );
    }
}

#[test]
fn measure_operational_limit_tradeoffs() {
    for (name, fen) in [
        ("countercheck_stress", COUNTERCHECK_STRESS),
        ("node_stress", NODE_STRESS),
    ] {
        for (nodes, plies) in [(1000, 64), (10_000, 8), (10_000, 64), (50_000, 64)] {
            let mut budget = EvaluationBudget::new(nodes, plies);
            let started = Instant::now();
            let score = qsearch_complete(&position(fen), -i32::MAX, i32::MAX, &mut budget, 0);
            println!("qsearch {name} limit={nodes}/{plies}: score={score:?}, visits={}, deepest={}, us={}", budget.visited_nodes, budget.deepest_ply, started.elapsed().as_micros());
            assert!(budget.deepest_ply <= plies);
            if nodes == 1000 || plies == 8 {
                assert_eq!(score, None);
            }
        }
    }
}

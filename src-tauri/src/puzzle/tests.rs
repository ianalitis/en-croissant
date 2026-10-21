use super::*;
use diesel::connection::SimpleConnection;

fn database(name: &str, rows: &[(i32, i32, &str)]) -> (tempfile::TempDir, String) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(name).to_str().unwrap().to_owned();
    let mut db = diesel::SqliteConnection::establish(&path).unwrap();
    db.batch_execute(
        "CREATE TABLE puzzles (
            id INTEGER PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL,
            rating INTEGER NOT NULL, rating_deviation INTEGER NOT NULL,
            popularity INTEGER NOT NULL, nb_plays INTEGER NOT NULL
        );
        CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE puzzle_themes (puzzle_id INTEGER NOT NULL, theme_id INTEGER NOT NULL);",
    )
    .unwrap();
    for (index, &(id, rating, theme)) in rows.iter().enumerate() {
        diesel::insert_into(puzzles::table)
            .values((
                puzzles::id.eq(id),
                puzzles::fen.eq("8/8/8/8/8/4k3/8/4K3 w - - 0 1"),
                puzzles::moves.eq("e1d1"),
                puzzles::rating.eq(rating),
                puzzles::rating_deviation.eq(50),
                puzzles::popularity.eq(90),
                puzzles::nb_plays.eq(100),
            ))
            .execute(&mut db)
            .unwrap();
        diesel::insert_into(themes::table)
            .values((themes::id.eq(index as i32), themes::name.eq(theme)))
            .execute(&mut db)
            .unwrap();
        diesel::insert_into(puzzle_themes::table)
            .values((
                puzzle_themes::puzzle_id.eq(id),
                puzzle_themes::theme_id.eq(index as i32),
            ))
            .execute(&mut db)
            .unwrap();
    }
    (directory, path)
}

#[test]
fn switching_databases_with_identical_filters_does_not_reuse_old_puzzles() {
    let (_first_directory, first) =
        database("first.db3", &[(1, 2100, "endgame"), (2, 2100, "endgame")]);
    let (_second_directory, second) = database("second.db3", &[(3, 2100, "endgame")]);
    let mut cache = PuzzleCache::new();
    cache.get_puzzles(&first, 2000, 2200, &None).unwrap();
    assert!(cache.get_next_puzzle().is_some());
    cache.get_puzzles(&second, 2000, 2200, &None).unwrap();
    assert_eq!(cache.get_next_puzzle().unwrap().id, 3);
    cache.get_puzzles(&first, 2000, 2200, &None).unwrap();
    assert!(matches!(cache.get_next_puzzle().unwrap().id, 1 | 2));
}

#[test]
fn switching_to_an_empty_database_does_not_return_old_puzzles() {
    let (_first_directory, first) =
        database("first.db3", &[(1, 2100, "endgame"), (2, 2100, "endgame")]);
    let (_empty_directory, empty) = database("empty.db3", &[]);
    let mut cache = PuzzleCache::new();
    cache.get_puzzles(&first, 2000, 2200, &None).unwrap();
    assert!(cache.get_next_puzzle().is_some());
    cache.get_puzzles(&empty, 2000, 2200, &None).unwrap();
    assert!(cache.get_next_puzzle().is_none());
    cache.get_puzzles(&first, 2000, 2200, &None).unwrap();
    assert!(cache.get_next_puzzle().is_some());
}

#[test]
fn exhausted_short_batch_is_refilled() {
    let (_directory, path) = database("single.db3", &[(1, 2100, "endgame")]);
    let mut cache = PuzzleCache::new();
    for _ in 0..3 {
        cache.get_puzzles(&path, 2000, 2200, &None).unwrap();
        assert_eq!(cache.get_next_puzzle().unwrap().id, 1);
    }
}

#[test]
fn exhausted_filtered_batch_is_refilled_without_losing_filters() {
    let (_directory, path) = database(
        "filtered.db3",
        &[
            (1, 2100, "endgame"),
            (2, 1800, "endgame"),
            (3, 2100, "fork"),
        ],
    );
    let mut cache = PuzzleCache::new();
    for _ in 0..3 {
        cache
            .get_puzzles(&path, 2000, 2200, &Some("endgame".to_owned()))
            .unwrap();
        assert_eq!(cache.get_next_puzzle().unwrap().id, 1);
    }
}

#[test]
fn changing_rating_or_theme_invalidates_the_cached_batch() {
    let (_directory, path) = database(
        "filters.db3",
        &[
            (1, 1800, "endgame"),
            (2, 1800, "endgame"),
            (3, 2100, "fork"),
        ],
    );
    let mut cache = PuzzleCache::new();
    cache.get_puzzles(&path, 1700, 1900, &None).unwrap();
    assert!(matches!(cache.get_next_puzzle().unwrap().id, 1 | 2));
    cache.get_puzzles(&path, 2000, 2200, &None).unwrap();
    assert_eq!(cache.get_next_puzzle().unwrap().id, 3);
    cache
        .get_puzzles(&path, 1700, 2200, &Some("endgame".to_owned()))
        .unwrap();
    assert!(matches!(cache.get_next_puzzle().unwrap().id, 1 | 2));
    cache
        .get_puzzles(&path, 1700, 2200, &Some("missing".to_owned()))
        .unwrap();
    assert!(cache.get_next_puzzle().is_none());
}

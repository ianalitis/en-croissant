use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

use crate::{error::Error, AppState};

const GAME_OFFSET_FREQ: usize = 100;

struct PgnParser {
    reader: BufReader<File>,
    line: String,
    game: String,
    start: u64,
}

impl PgnParser {
    fn new(file: File) -> Self {
        let mut reader = BufReader::new(file);
        let start = ignore_bom(&mut reader).unwrap_or(0);
        Self {
            reader,
            line: String::new(),
            game: String::new(),
            start,
        }
    }

    fn position(&mut self) -> io::Result<u64> {
        self.reader.stream_position()
    }

    fn offset_by_index(&mut self, n: usize, state: &AppState, file: &String) -> io::Result<()> {
        let offset_index = n / GAME_OFFSET_FREQ;
        let n_left = n % GAME_OFFSET_FREQ;
        let wrapped_pgn_offsets = state.pgn_offsets.get(file);
        if wrapped_pgn_offsets.is_none() {
            self.reader.seek(SeekFrom::Start(self.start))?;
            self.skip_games(n)?;
            return Ok(());
        }
        let pgn_offsets = wrapped_pgn_offsets.unwrap();

        if offset_index == 0 || offset_index < pgn_offsets.len() {
            let offset = match offset_index {
                0 => self.start,
                _ => pgn_offsets[offset_index - 1],
            };

            self.reader.seek(SeekFrom::Start(offset))?;

            self.skip_games(n_left)?;
        } else {
            self.reader.seek(SeekFrom::Start(self.start))?;
            self.skip_games(n)?;
        }

        Ok(())
    }

    /// Skip n games, and return the number of bytes read
    fn skip_games(&mut self, n: usize) -> io::Result<usize> {
        let mut new_game = false;
        let mut skipped = 0;
        let mut count = 0;
        let mut in_comment = false;

        if n == 0 {
            return Ok(0);
        }

        let mut line = String::new();
        loop {
            let res = self.reader.read_line(&mut line);
            if res.is_err() {
                continue;
            }
            let bytes = res.unwrap();
            skipped += bytes;
            if bytes == 0 {
                break;
            }
            let is_header = !in_comment && line.starts_with('[');
            for c in line.chars() {
                match c {
                    '{' => in_comment = true,
                    '}' => in_comment = false,
                    _ => {}
                }
            }
            if is_header {
                if new_game {
                    count += 1;
                    if count == n {
                        self.reader.seek(SeekFrom::Current(-(bytes as i64)))?;
                        break;
                    }
                    new_game = false;
                }
            } else {
                new_game = true;
            }
            line.clear();
        }
        Ok(skipped)
    }

    fn read_game(&mut self) -> io::Result<String> {
        let mut new_game = false;
        let mut in_comment = false;
        self.game.clear();
        loop {
            let res = self.reader.read_line(&mut self.line);
            if res.is_err() {
                continue;
            }
            let bytes = res.unwrap();
            if bytes == 0 {
                break;
            }
            let is_header = !in_comment && self.line.starts_with('[');
            for c in self.line.chars() {
                match c {
                    '{' => in_comment = true,
                    '}' => in_comment = false,
                    _ => {}
                }
            }
            if is_header {
                if new_game {
                    break;
                }
            } else {
                new_game = true;
            }
            self.game.push_str(&self.line);
            self.line.clear();
        }
        Ok(self.game.clone())
    }
}

fn ignore_bom(reader: &mut BufReader<File>) -> io::Result<u64> {
    let mut bom = [0; 3];
    reader.read_exact(&mut bom)?;
    if bom != [0xEF, 0xBB, 0xBF] {
        reader.seek(SeekFrom::Start(0))?;
        return Ok(0);
    }
    Ok(3)
}

#[tauri::command]
#[specta::specta]
pub async fn count_pgn_games(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<i32, Error> {
    let files_string = file.to_string_lossy().to_string();

    let file = File::open(&file)?;

    let mut parser = PgnParser::new(file.try_clone()?);

    let mut offsets = Vec::new();

    let mut count = 0;

    while let Ok(skipped) = parser.skip_games(1) {
        if skipped == 0 {
            break;
        }
        count += 1;
        if count % GAME_OFFSET_FREQ as i32 == 0 {
            let cur_pos = parser.position()?;
            offsets.push(cur_pos);
        }
    }

    state.pgn_offsets.insert(files_string, offsets);
    Ok(count)
}

#[tauri::command]
#[specta::specta]
pub async fn read_games(
    file: PathBuf,
    start: i32,
    end: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, Error> {
    let file_r = File::open(&file)?;

    let mut parser = PgnParser::new(file_r.try_clone()?);

    parser.offset_by_index(start as usize, &state, &file.to_string_lossy().to_string())?;

    let mut games: Vec<String> = Vec::with_capacity((end - start) as usize);

    for _ in start..=end {
        let game = parser.read_game()?;
        if game.is_empty() {
            break;
        }
        games.push(game);
    }
    Ok(games)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_game(
    file: PathBuf,
    n: i32,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let file_r = File::open(&file)?;

    let mut parser = PgnParser::new(file_r.try_clone()?);

    parser.offset_by_index(n as usize, &state, &file.to_string_lossy().to_string())?;

    let starting_bytes = parser.position()?;

    parser.skip_games(1)?;

    let mut file_w = OpenOptions::new().write(true).open(file)?;

    file_w.seek(SeekFrom::Start(starting_bytes))?;

    write_to_end(&mut parser.reader, &mut file_w)?;
    Ok(())
}

fn write_to_end<R: Read>(reader: &mut R, writer: &mut File) -> io::Result<()> {
    io::copy(reader, writer)?;
    let end = writer.stream_position()?;
    writer.set_len(end)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn write_game(
    file_path: String,
    n: i32,
    pgn: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let file = PathBuf::from(file_path);
    if !file.exists() {
        File::create(&file)?;
    }

    let mut file_r = File::open(&file)?;
    let mut file_w = OpenOptions::new().write(true).open(&file)?;

    let mut tmpf = tempfile::tempfile()?;
    io::copy(&mut file_r.try_clone()?, &mut tmpf)?;

    file_r.seek(SeekFrom::Start(0))?;
    let mut parser = PgnParser::new(file_r.try_clone()?);

    parser.offset_by_index(n as usize, &state, &file.to_string_lossy().to_string())?;

    tmpf.seek(SeekFrom::Start(parser.position()?))?;
    tmpf.write_all(pgn.as_bytes())?;

    parser.skip_games(1)?;

    write_to_end(&mut parser.reader, &mut tmpf)?;

    tmpf.seek(SeekFrom::Start(0))?;

    write_to_end(&mut tmpf, &mut file_w)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex_pgn;
    use serde_json::{json, Value};
    use shakmaty::{fen::Fen, Color};
    use tauri::{
        test::{mock_builder, mock_context, noop_assets, MockRuntime},
        Manager,
    };

    // A simple original mechanics study, not a training-strength benchmark.
    const STUDY: &str = include_str!("../../src/tests/fixtures/rook-capture.pgn");
    const ANNOTATION: &str = "Take the undefended rook.";
    const REVISED_ANNOTATION: &str = "The e-pawn captures the undefended rook on d5.";

    fn mock_app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(AppState::default())
            .build(mock_context(noop_assets()))
            .unwrap()
    }

    fn expected_study_tokens(annotation: &str) -> Value {
        json!([
            {"type": "Header", "value": {"tag": "Event", "value": "Original capture study"}},
            {"type": "Header", "value": {"tag": "Result", "value": "*"}},
            {"type": "Header", "value": {"tag": "SetUp", "value": "1"}},
            {"type": "Header", "value": {"tag": "FEN", "value": "7k/7p/8/3r4/4P3/8/7P/K7 w - - 4 23"}},
            {"type": "San", "value": "exd5"},
            {"type": "Nag", "value": "$1"},
            {"type": "Comment", "value": annotation},
            {"type": "ParenOpen"},
            {"type": "San", "value": "h3"},
            {"type": "Nag", "value": "$2"},
            {"type": "Comment", "value": "Misses the capture."},
            {"type": "San", "value": "Rd4"},
            {"type": "ParenClose"},
            {"type": "San", "value": "Kg7"},
            {"type": "San", "value": "h3"},
            {"type": "Outcome", "value": "*"}
        ])
    }

    #[tokio::test]
    async fn annotated_study_survives_native_save_export_and_reopen() {
        let app = mock_app();
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("study.pgn");
        let exported = directory.path().join("exported.pgn");
        std::fs::write(&source, STUDY).unwrap();

        assert_eq!(
            count_pgn_games(source.clone(), app.state()).await.unwrap(),
            1
        );
        let imported = read_games(source.clone(), 0, 0, app.state()).await.unwrap();
        assert_eq!(imported, [STUDY]);
        let tokens = serde_json::to_value(lex_pgn(imported[0].clone()).await.unwrap()).unwrap();
        assert_eq!(tokens, expected_study_tokens(ANNOTATION));
        let setup = tokens[3]["value"]["value"]
            .as_str()
            .unwrap()
            .parse::<Fen>()
            .unwrap()
            .into_setup();
        assert_eq!(setup.turn, Color::White);
        assert_eq!(setup.halfmoves, 4);
        assert_eq!(setup.fullmoves.get(), 23);

        let revised = imported[0].replace(ANNOTATION, REVISED_ANNOTATION);
        write_game(
            source.to_string_lossy().into_owned(),
            0,
            revised.clone(),
            app.state(),
        )
        .await
        .unwrap();
        assert_eq!(
            count_pgn_games(source.clone(), app.state()).await.unwrap(),
            1
        );
        let saved = read_games(source.clone(), 0, 0, app.state()).await.unwrap();
        assert_eq!(saved, [revised]);
        let saved_tokens = serde_json::to_value(lex_pgn(saved[0].clone()).await.unwrap()).unwrap();
        assert_eq!(saved_tokens, expected_study_tokens(REVISED_ANNOTATION));

        // Export through the same native writer into a previously absent path.
        assert!(!exported.exists());
        write_game(
            exported.to_string_lossy().into_owned(),
            0,
            saved[0].clone(),
            app.state(),
        )
        .await
        .unwrap();
        assert_eq!(
            count_pgn_games(exported.clone(), app.state())
                .await
                .unwrap(),
            1
        );
        let reopened = read_games(exported, 0, 0, app.state()).await.unwrap();
        assert_eq!(reopened, saved);
        assert_eq!(
            serde_json::to_value(lex_pgn(reopened[0].clone()).await.unwrap()).unwrap(),
            saved_tokens
        );
        assert_eq!(std::fs::read_to_string(source).unwrap(), saved[0]);
    }

    #[tokio::test]
    async fn replacing_middle_study_preserves_both_sentinel_games() {
        let app = mock_app();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("collection.pgn");
        let before =
            "[Event \"Before sentinel\"]\n[Result \"1-0\"]\n\n1. e4 {Keep before.} e5 1-0\n\n";
        let after =
            "[Event \"After sentinel\"]\n[Result \"0-1\"]\n\n1. d4 $6 d5 {Keep after.} 0-1\n\n";
        std::fs::write(&path, format!("{before}{STUDY}{after}")).unwrap();
        assert_eq!(count_pgn_games(path.clone(), app.state()).await.unwrap(), 3);
        let original = read_games(path.clone(), 0, 2, app.state()).await.unwrap();
        assert_eq!(original, [before, STUDY, after]);
        assert_eq!(
            serde_json::to_value(lex_pgn(original[1].clone()).await.unwrap()).unwrap(),
            expected_study_tokens(ANNOTATION)
        );

        // Grow, then shrink the middle game to exercise suffix copying and truncation.
        for annotation in [REVISED_ANNOTATION, "Capture."] {
            let revised = original[1].replace(ANNOTATION, annotation);
            write_game(
                path.to_string_lossy().into_owned(),
                1,
                revised.clone(),
                app.state(),
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                format!("{before}{revised}{after}")
            );
            assert_eq!(count_pgn_games(path.clone(), app.state()).await.unwrap(), 3);
            let reopened = read_games(path.clone(), 0, 2, app.state()).await.unwrap();
            assert_eq!(reopened.len(), 3);
            assert_eq!(reopened[0], original[0]);
            assert_eq!(reopened[2], original[2]);
            assert_eq!(reopened[1], revised);
            let middle = read_games(path.clone(), 1, 1, app.state()).await.unwrap();
            assert_eq!(middle, [reopened[1].clone()]);
            assert_eq!(
                serde_json::to_value(lex_pgn(middle[0].clone()).await.unwrap()).unwrap(),
                expected_study_tokens(annotation)
            );
        }
    }
}

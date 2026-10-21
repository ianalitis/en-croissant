use std::{fmt::Display, path::PathBuf, process::Stdio};

use log::error;
use serde::Serialize;
use specta::Type;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use vampirc_uci::UciMessage;

use crate::error::Error;

use super::{normalize_uci_moves_for_fen, types::GoMode, EngineOption};

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum EngineLog {
    Gui(String),
    Engine(String),
}

pub type EngineReader = Lines<BufReader<ChildStdout>>;

fn conditioning_key(name: &str) -> Option<usize> {
    ["Elo", "SelfElo", "OppoElo"]
        .iter()
        .position(|key| name.eq_ignore_ascii_case(key))
}

// A conservative compatibility signature, not binary attestation. Only the
// actual process's current initialization exchange can enable specialization.
#[derive(Default)]
struct MaiaSignature {
    identity: [bool; 2],
    defaults: [Option<u16>; 3],
    invalid: bool,
}

impl MaiaSignature {
    fn observe(&mut self, line: &str) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.starts_with(&["id", "name"]) || fields.starts_with(&["id", "author"]) {
            let index = usize::from(fields[1] == "author");
            let expected = ["Maia3", "CSSLab"][index];
            self.invalid |= self.identity[index] || fields.get(2..) != Some(&[expected][..]);
            self.identity[index] = true;
        } else if fields.starts_with(&["option", "name"]) {
            let Some(index) = fields.get(2).and_then(|name| conditioning_key(name)) else {
                return;
            };
            if self.defaults[index].is_some() {
                self.invalid = true;
            }
            self.defaults[index] = Self::spin_default(&fields);
            self.invalid |= self.defaults[index].is_none();
        }
    }

    fn spin_default(fields: &[&str]) -> Option<u16> {
        if fields.len() != 11 || fields[3..5] != ["type", "spin"] {
            return None;
        }
        let mut values = [None; 3];
        for pair in fields[5..].chunks_exact(2) {
            let index = ["default", "min", "max"]
                .iter()
                .position(|key| *key == pair[0])?;
            if values[index].is_some() {
                return None;
            }
            values[index] = Some(pair[1].parse::<u16>().ok()?);
        }
        let default = values[0]?;
        (default <= 5000 && values[1] == Some(0) && values[2] == Some(5000)).then_some(default)
    }

    fn channel_defaults(&self) -> Option<[u16; 2]> {
        if self.invalid || self.identity != [true, true] || self.defaults[0].is_none() {
            return None;
        }
        Some([self.defaults[1]?, self.defaults[2]?])
    }
}

pub struct BaseEngine {
    pub stdin: ChildStdin,
    pub reader: Option<EngineReader>,
    #[allow(dead_code)]
    child: Child,
    logs: Vec<EngineLog>,
    maia_defaults: Option<[u16; 2]>,
}

impl BaseEngine {
    pub async fn spawn(path: PathBuf) -> Result<Self, Error> {
        let mut command = Command::new(&path);
        command.current_dir(path.parent().unwrap_or(&path));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command.spawn()?;

        let stdin = child.stdin.take().ok_or(Error::NoStdin)?;
        let stdout = child.stdout.take().ok_or(Error::NoStdout)?;
        let reader = BufReader::new(stdout).lines();

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut stderr_reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = stderr_reader.next_line().await {
                    error!("Engine stderr: {}", line);
                }
            });
        }

        Ok(Self {
            stdin,
            reader: Some(reader),
            child,
            logs: Vec::new(),
            maia_defaults: None,
        })
    }

    pub fn take_reader(&mut self) -> Option<EngineReader> {
        self.reader.take()
    }

    /// Only the existing, actual UCI handshake signature is recognized here.
    /// Unrecognized engines retain their behavior, not a certification of scores.
    pub(crate) fn ensure_objective_analysis(&self) -> Result<(), Error> {
        if self.maia_defaults.is_some() {
            Err(Error::MaiaObjectiveAnalysisUnsupported)
        } else {
            Ok(())
        }
    }

    pub fn reader_mut(&mut self) -> Option<&mut EngineReader> {
        self.reader.as_mut()
    }

    pub fn get_logs(&self) -> Vec<EngineLog> {
        self.logs.clone()
    }

    fn log_gui(&mut self, cmd: &str) {
        self.logs.push(EngineLog::Gui(format!("{}\n", cmd)));
    }

    pub fn log_engine(&mut self, line: &str) {
        self.logs.push(EngineLog::Engine(line.to_string()));
    }

    pub async fn init_uci(&mut self) -> Result<(), Error> {
        self.maia_defaults = None;
        self.send("uci").await?;
        let mut signature = MaiaSignature::default();
        loop {
            let line = self
                .reader
                .as_mut()
                .ok_or(Error::EngineDisconnected)?
                .next_line()
                .await?
                .ok_or(Error::EngineDisconnected)?;
            self.log_engine(&line);
            if line.starts_with("uciok") {
                if line.trim() == "uciok" {
                    self.maia_defaults = signature.channel_defaults();
                }
                break;
            }
            signature.observe(&line);
        }
        self.send("isready").await?;
        self.wait_for("readyok").await?;
        Ok(())
    }

    /// None leaves ordinary engines' option ordering and delta behavior intact.
    /// Validate the entire raw request, including overwritten duplicates, before
    /// callers emit any option (including their automatic UCI_Chess960 option).
    pub(crate) fn normalize_conditioning(
        &self,
        options: &[EngineOption],
    ) -> Result<Option<Vec<EngineOption>>, Error> {
        let Some(defaults) = self.maia_defaults else {
            return Ok(None);
        };
        let mut values = [None; 3];
        let mut normalized = Vec::with_capacity(options.len() + 2);
        for option in options {
            if let Some(index) = conditioning_key(&option.name) {
                let value = option
                    .value
                    .parse::<u16>()
                    .ok()
                    .filter(|value| *value <= 5000)
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            format!("{} must be an integer in 0..5000", option.name),
                        )
                    })?;
                values[index] = Some(value);
            } else {
                normalized.push(option.clone());
            }
        }
        for (index, name) in ["SelfElo", "OppoElo"].iter().enumerate() {
            normalized.push(EngineOption {
                name: (*name).into(),
                value: values[index + 1]
                    .or(values[0])
                    .unwrap_or(defaults[index])
                    .to_string(),
            });
        }
        Ok(Some(normalized))
    }

    pub async fn send(&mut self, cmd: &str) -> Result<(), Error> {
        self.log_gui(cmd);
        let msg = format!("{}\n", cmd);
        self.stdin.write_all(msg.as_bytes()).await?;
        Ok(())
    }

    pub async fn wait_for(&mut self, expected: &str) -> Result<(), Error> {
        loop {
            let line = {
                let reader = self.reader.as_mut().ok_or(Error::EngineDisconnected)?;
                reader.next_line().await?
            };
            let Some(line) = line else {
                return Err(Error::EngineDisconnected);
            };
            self.logs.push(EngineLog::Engine(line.clone()));
            if line.starts_with(expected) {
                return Ok(());
            }
        }
    }

    pub async fn set_option<T>(&mut self, name: &str, value: T) -> Result<(), Error>
    where
        T: Display,
    {
        let cmd = format!("setoption name {} value {}", name, value);
        self.send(&cmd).await
    }

    pub async fn set_position(&mut self, fen: &str, moves: &[String]) -> Result<(), Error> {
        let normalized_moves = normalize_uci_moves_for_fen(fen, moves)?;
        let cmd = if moves.is_empty() {
            format!("position fen {}", fen)
        } else {
            format!("position fen {} moves {}", fen, normalized_moves.join(" "))
        };
        self.send(&cmd).await
    }

    pub async fn go(&mut self, mode: &GoMode) -> Result<(), Error> {
        let cmd = mode.to_uci_string();
        self.send(&cmd).await
    }

    pub async fn stop(&mut self) -> Result<(), Error> {
        self.send("stop").await
    }

    pub async fn quit(&mut self) -> Result<(), Error> {
        self.send("quit").await
    }

    /// Report engines are disposable. Unlike shared live-engine `quit`, this
    /// forcibly terminates and waits, including engines that ignore UCI commands.
    pub async fn terminate_report(&mut self) -> Result<(), Error> {
        if self.child.try_wait()?.is_some() {
            return Ok(());
        }
        if let Err(error) = self.child.kill().await {
            // The child may have exited between try_wait and kill. Only a
            // successfully collected exit status proves cleanup in that case.
            if self.child.try_wait()?.is_none() {
                return Err(error.into());
            }
        }
        Ok(())
    }

    pub async fn wait_for_bestmove(&mut self) -> Result<String, Error> {
        let reader = self.reader.as_mut().ok_or(Error::EngineDisconnected)?;
        while let Some(line) = reader.next_line().await? {
            self.logs.push(EngineLog::Engine(line.clone()));
            if let UciMessage::BestMove { best_move, .. } = vampirc_uci::parse_one(&line) {
                return Ok(best_move.to_string());
            }
        }
        Err(Error::EngineDisconnected)
    }

    pub fn kill_sync(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl Drop for BaseEngine {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

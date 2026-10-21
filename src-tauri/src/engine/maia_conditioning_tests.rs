//! Disposable protocol fixture, not a Maia binary/model or score-validity test.
//! The alias deliberately overwrites both channels, matching the admitted contract.
use super::{BaseEngine, EngineOption};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};
use tokio::time::{sleep, timeout};

pub(crate) const WATCHDOG: Duration = Duration::from_secs(12);
pub(crate) const SIGNATURE: &str = "id name Maia3\nid author CSSLab\noption name Elo type spin default 1500 min 0 max 5000\noption name SelfElo type spin default 1200 min 0 max 5000\noption name OppoElo type spin default 1300 min 0 max 5000\n";

pub(crate) fn opts(pairs: &[(&str, &str)]) -> Vec<EngineOption> {
    pairs
        .iter()
        .map(|(name, value)| EngineOption {
            name: (*name).into(),
            value: (*value).into(),
        })
        .collect()
}

unsafe extern "C" {
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

pub(crate) struct Fixture {
    directory: tempfile::TempDir,
    pub(crate) path: PathBuf,
}

impl Fixture {
    pub(crate) fn new(signature: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        // No identity inference from executable or profile names.
        let path = directory.path().join("renamed-unrelated-executable");
        std::fs::write(directory.path().join("signature"), signature).unwrap();
        std::fs::write(
            &path,
            r#"#!/bin/bash
printf '%s' "$$" > child.pid
self=1200
oppo=1300
# No descendants. read and SECONDS bound the entire lifetime, even after a panic.
while (( SECONDS < 8 )); do
    IFS= read -r -t 1 line || continue
    printf '%s\n' "$line" >> commands
    case "$line" in
        uci)
            while IFS= read -r declaration; do printf '%s\n' "$declaration"; done < signature
            printf 'uciok\n'
            ;;
        'setoption name Elo value '*) self=${line##* value }; oppo=$self ;;
        'setoption name SelfElo value '*) self=${line##* value } ;;
        'setoption name OppoElo value '*) oppo=${line##* value } ;;
        isready)
            printf '%s,%s\n' "$self" "$oppo" > state
            printf 'readyok\n'
            ;;
        go*)
            printf '%s,%s\n' "$self" "$oppo" > state
            if [ -f stall-go ]; then
                printf 'go' > phase
                while (( SECONDS < 8 )); do IFS= read -r -t 1 ignored || :; done
                exit 91
            fi
            if [ -f score-go ]; then
                printf 'info depth 1 nodes 10 multipv 1 score cp 42 pv e2e4\n'
                printf 'info depth 1 nodes 10 multipv 2 score cp 21 pv d2d4\n'
            fi
            printf 'bestmove e2e4\n'
            [ -f score-go ] && exit 0
            ;;
        quit) exit 0 ;;
    esac
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self { directory, path }
    }

    pub(crate) fn signature(&self, signature: &str) {
        std::fs::write(self.directory.path().join("signature"), signature).unwrap();
    }

    pub(crate) fn stall_go(&self) {
        std::fs::write(self.directory.path().join("stall-go"), "").unwrap();
    }

    pub(crate) fn score_and_exit_on_go(&self) {
        std::fs::write(self.directory.path().join("score-go"), "").unwrap();
    }

    pub(crate) fn all_commands(&self) -> Vec<String> {
        std::fs::read_to_string(self.directory.path().join("commands"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    pub(crate) async fn phase(&self) {
        timeout(WATCHDOG, async {
            while !self.directory.path().join("phase").exists() {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fixture never reached go");
    }

    pub(crate) fn commands(&self) -> Vec<String> {
        std::fs::read_to_string(self.directory.path().join("commands"))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("setoption "))
            .map(str::to_owned)
            .collect()
    }

    pub(crate) fn state(&self) -> String {
        std::fs::read_to_string(self.directory.path().join("state"))
            .unwrap()
            .trim()
            .into()
    }

    pub(crate) async fn sync(&self, base: &mut BaseEngine) {
        timeout(WATCHDOG, async {
            base.send("isready").await.unwrap();
            base.wait_for("readyok").await.unwrap();
        })
        .await
        .unwrap();
    }

    fn pid(&self) -> Option<i32> {
        std::fs::read_to_string(self.directory.path().join("child.pid"))
            .ok()?
            .parse()
            .ok()
    }

    pub(crate) fn assert_reaped(&self) {
        let pid = self.pid().expect("fixture must have started");
        let mut status = 0;
        let result = unsafe { waitpid(pid, &mut status, 1) };
        let errno = std::io::Error::last_os_error().raw_os_error();
        assert_eq!(result, -1, "fixture child {pid} was not reaped");
        assert_eq!(errno, Some(10), "expected ECHILD");
    }

    pub(crate) async fn reap_after_drop(&self) {
        let pid = self.pid().expect("fixture must have started");
        timeout(WATCHDOG, async {
            loop {
                let mut status = 0;
                let result = unsafe { waitpid(pid, &mut status, 1) };
                if result == pid {
                    break;
                }
                if result == -1 {
                    assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(10));
                    break;
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("dropped fixture child did not exit");
        self.assert_reaped();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(pid) = self.pid() {
            // BaseEngine drops before this fixture and kills only its child. The
            // independent shell watchdog also bounds this exact-child fallback wait.
            let mut status = 0;
            loop {
                if unsafe { waitpid(pid, &mut status, 0) } >= 0
                    || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                {
                    break;
                }
            }
        }
    }
}

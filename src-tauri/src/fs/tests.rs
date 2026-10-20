use std::{
    io::{Cursor, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use flate2::{write::GzEncoder, Compression};
use tauri::{
    test::{mock_builder, mock_context, noop_assets, MockRuntime},
    Listener, Manager,
};
use tauri_specta::Event;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::download_file;
use crate::{
    error::Error,
    progress::{ProgressEvent, ProgressItem},
    AppState,
};

const ID: &str = "test-download";
const CONTENT: &[u8] = b"downloaded engine bytes\0\xff";
const SENTINEL: &[u8] = b"existing engine must survive";
const MEMBERS: [&str; 2] = ["engine", "nested/new-member"];

fn fixture(extension: &str) -> Vec<u8> {
    if extension == ".bin" {
        return CONTENT.to_vec();
    }
    if extension == ".zip" {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for member in MEMBERS {
            archive
                .start_file(member, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(CONTENT).unwrap();
        }
        return archive.finish().unwrap().into_inner();
    }
    let mut archive = tar::Builder::new(Vec::new());
    for member in MEMBERS {
        let mut header = tar::Header::new_gnu();
        header.set_size(CONTENT.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, member, CONTENT).unwrap();
    }
    let bytes = archive.into_inner().unwrap();
    if extension == ".tar.gz" {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&bytes).unwrap();
        encoder.finish().unwrap()
    } else {
        assert_eq!(extension, ".tar");
        bytes
    }
}

async fn serve(status: u16, extension: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/engine{extension}",
        listener.local_addr().unwrap()
    );
    let body = fixture(extension);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
            assert!(request.len() < 8192);
        }
        let reason = match status {
            200 => "OK",
            404 => "Not Found",
            500 => "Internal Server Error",
            _ => unreachable!(),
        };
        let mut response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(&body);
        let sent = stream.write_all(&response).await;
        // Error responses may be closed by the client without consuming the body.
        if status == 200 {
            sent.unwrap();
        }
    });
    (url, server)
}

fn mock_app() -> (tauri::App<MockRuntime>, Arc<Mutex<Vec<serde_json::Value>>>) {
    let app = mock_builder()
        .manage(AppState::default())
        .build(mock_context(noop_assets()))
        .unwrap();
    tauri_specta::Builder::<MockRuntime>::new()
        .events(tauri_specta::collect_events![ProgressEvent])
        .mount_events(&app);
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    app.listen(ProgressEvent::NAME, move |event| {
        recorded
            .lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    (app, events)
}

async fn rejects_http_error(status: u16, extension: &str) {
    for existing in [false, true] {
        let (app, events) = mock_app();
        let state = app.state::<AppState>();
        state.progress_state.insert(
            ID.into(),
            ProgressItem {
                id: ID.into(),
                progress: 37.0,
                finished: false,
            },
        );
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("destination");
        let sentinel = if extension == ".bin" {
            destination.clone()
        } else {
            destination.join("engine")
        };
        if existing {
            if extension != ".bin" {
                std::fs::create_dir(&destination).unwrap();
            }
            std::fs::write(&sentinel, SENTINEL).unwrap();
        }
        let (url, server) = serve(status, extension).await;
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            download_file(
                ID.into(),
                url,
                destination.clone(),
                app.handle().clone(),
                app.state(),
                None,
                None,
                None,
            ),
        )
        .await
        .expect("local download timed out");
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("local HTTP server timed out")
            .unwrap();

        assert!(
            matches!(&result, Err(Error::Reqwest(error)) if error.status().map(|value| value.as_u16()) == Some(status)),
            "expected Reqwest status {status} for {extension}, got {result:?}"
        );
        if existing {
            assert_eq!(std::fs::read(&sentinel).unwrap(), SENTINEL);
            if extension != ".bin" {
                assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 1);
                assert!(!destination.join("nested").exists());
            }
        } else {
            assert!(!destination.exists());
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
        assert_eq!(state.progress_state.len(), 1);
        let progress = state.progress_state.get(ID).unwrap();
        assert_eq!(progress.id, ID);
        assert_eq!(progress.progress, 37.0);
        assert!(!progress.finished);
        assert!(events.lock().unwrap().is_empty());
    }
}

async fn accepts_http_success(extension: &str) {
    for finalize in [None, Some(false)] {
        let (app, events) = mock_app();
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("destination");
        let (url, server) = serve(200, extension).await;
        tokio::time::timeout(
            Duration::from_secs(10),
            download_file(
                ID.into(),
                url,
                destination.clone(),
                app.handle().clone(),
                app.state(),
                None,
                finalize,
                None,
            ),
        )
        .await
        .expect("local download timed out")
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("local HTTP server timed out")
            .unwrap();
        if extension == ".bin" {
            assert_eq!(std::fs::read(&destination).unwrap(), CONTENT);
        } else {
            for member in MEMBERS {
                assert_eq!(std::fs::read(destination.join(member)).unwrap(), CONTENT);
            }
        }
        let state = app.state::<AppState>();
        let progress = state.progress_state.get(ID).unwrap();
        assert_eq!(progress.id, ID);
        assert_eq!(progress.progress, 100.0);
        assert_eq!(progress.finished, finalize.unwrap_or(true));
        let events = events.lock().unwrap();
        assert!(!events.is_empty());
        assert!(events.iter().all(|event| event["id"] == ID));
        assert_eq!(events.last().unwrap()["progress"], 100.0);
        assert_eq!(events.last().unwrap()["finished"], finalize.unwrap_or(true));
        assert_eq!(
            events
                .iter()
                .filter(|event| event["finished"] == true)
                .count(),
            usize::from(finalize.unwrap_or(true))
        );
    }
}

macro_rules! error_test {
    ($name:ident, $status:literal, $extension:literal) => {
        #[tokio::test]
        async fn $name() {
            rejects_http_error($status, $extension).await;
        }
    };
}

macro_rules! success_test {
    ($name:ident, $extension:literal) => {
        #[tokio::test]
        async fn $name() {
            accepts_http_success($extension).await;
        }
    };
}

error_test!(http_404_raw, 404, ".bin");
error_test!(http_404_zip, 404, ".zip");
error_test!(http_404_tar, 404, ".tar");
error_test!(http_404_tar_gz, 404, ".tar.gz");
error_test!(http_500_raw, 500, ".bin");
error_test!(http_500_zip, 500, ".zip");
error_test!(http_500_tar, 500, ".tar");
error_test!(http_500_tar_gz, 500, ".tar.gz");
success_test!(http_200_raw, ".bin");
success_test!(http_200_zip, ".zip");
success_test!(http_200_tar, ".tar");
success_test!(http_200_tar_gz, ".tar.gz");

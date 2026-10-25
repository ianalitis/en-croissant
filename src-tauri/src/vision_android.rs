// Keep the existing IPC contract without claiming Android inference support.
// The desktop Candle backend requires ARM instructions not guaranteed on phones.
#[tauri::command]
#[specta::specta]
pub async fn recognize_chess_image(path: String) -> Result<String, String> {
    let _ = path;
    Err("Image recognition is unavailable in the Android preview".to_owned())
}

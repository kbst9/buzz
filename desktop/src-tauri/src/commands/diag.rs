use tauri::command;

/// Temporary diagnostics tap (feat/observer-diag): the webview has no
/// readable console in release builds, so gate-level observer diagnostics
/// are routed here and printed to stdout, where a terminal launch of the
/// app captures them. Remove with the branch once the observer-frame drop
/// is diagnosed.
#[command]
pub fn diag_log(message: String) {
    println!("[diag] {message}");
}

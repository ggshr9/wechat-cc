// wechat-cc desktop installer — Tauri command surface.
//
// The bundled `wechat-cc-cli` sidecar (a `bun build --compile`d
// self-contained binary built from the project's cli.ts) is the single
// source of truth for every CLI operation the GUI invokes. There is no
// dependency on a system-installed `bun`, no requirement for a cloned
// wechat-cc source tree, and no PATH lookup — the sidecar lives inside
// the .app/.exe/.deb bundle and is resolved by tauri-plugin-shell.

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn wechat_cli_json(app: AppHandle, args: Vec<String>) -> Result<Value, String> {
    let stdout = run_sidecar(&app, args).await?;
    serde_json::from_str(&stdout)
        .map_err(|err| format!("invalid JSON from wechat-cc: {err}\n{stdout}"))
}

#[tauri::command]
async fn wechat_cli_text(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    run_sidecar(&app, args).await
}

#[tauri::command]
fn render_qr_svg(text: String) -> Result<String, String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let code = QrCode::new(text.as_bytes()).map_err(|err| format!("qr encode failed: {err}"))?;
    Ok(code
        .render::<svg::Color<'_>>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(svg::Color("#111111"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

// Spawn the bundled sidecar and collect its stdout. Stderr is forwarded as
// part of the error payload so callers (the wizard / dashboard) can render a
// useful message when something goes wrong. Termination with a non-zero exit
// code is treated as failure regardless of stdout content.
async fn run_sidecar(app: &AppHandle, args: Vec<String>) -> Result<String, String> {
    let sidecar = app
        .shell()
        .sidecar("wechat-cc-cli")
        .map_err(|err| format!("failed to resolve wechat-cc-cli sidecar: {err}"))?;

    let (mut rx, _child) = sidecar
        .args(args)
        .spawn()
        .map_err(|err| format!("failed to spawn wechat-cc-cli: {err}"))?;

    let mut stdout = Vec::<u8>::new();
    let mut stderr = Vec::<u8>::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.extend_from_slice(&line);
                stdout.push(b'\n');
            }
            CommandEvent::Stderr(line) => {
                stderr.extend_from_slice(&line);
                stderr.push(b'\n');
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }

    let stdout_str = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr_str = String::from_utf8_lossy(&stderr).trim().to_string();
    if exit_code.unwrap_or(1) != 0 {
        if stderr_str.is_empty() {
            return Err(format!("wechat-cc-cli exited with code {:?}\n{stdout_str}", exit_code));
        }
        return Err(stderr_str);
    }
    Ok(stdout_str)
}

// Suppress unused warnings until streaming is wired through.
#[allow(dead_code)]
fn emit_log(app: &AppHandle, line: &str) {
    let _ = app.emit("wechat-cc:log", line);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            wechat_cli_json,
            wechat_cli_text,
            render_qr_svg
        ])
        .run(tauri::generate_context!())
        .expect("error while running wechat-cc desktop");
}

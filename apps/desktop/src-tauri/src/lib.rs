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

// Reads payload via a temp file instead of stdout. The bun --compile CLI
// loses bytes when pushing MB-sized JSON (sessions read-jsonl) through a
// pipe — pipe-buffer fills, EAGAIN, writes drop. The CLI's --out-file flag
// dumps the JSON to disk synchronously and prints just the small envelope
// {ok, out_file, bytes} on stdout, which we then read from disk.
#[tauri::command]
async fn wechat_cli_json_via_file(app: AppHandle, args: Vec<String>) -> Result<Value, String> {
    let id: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("wechat-cc-{id}-{}.json", std::process::id()));
    let tmp_str = tmp.to_string_lossy().to_string();
    let mut full_args = args;
    full_args.push("--out-file".into());
    full_args.push(tmp_str.clone());
    let _ = run_sidecar(&app, full_args).await?;
    let body = std::fs::read_to_string(&tmp).map_err(|err| format!("read {tmp_str}: {err}"))?;
    let _ = std::fs::remove_file(&tmp);
    serde_json::from_str(&body).map_err(|err| format!("invalid JSON in {tmp_str}: {err}"))
}

#[tauri::command]
async fn wechat_cli_text(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    run_sidecar(&app, args).await
}

// Direct file save — sidesteps the missing tauri-plugin-dialog/-fs.
// Without it, exportProjectMarkdown's `<a download>.click()` blob fallback
// silently no-ops in the Tauri webview (downloads aren't wired). Writes to
// $HOME/Downloads/<filename>; refuses anything that would escape that dir.
#[tauri::command]
fn save_text_file(filename: String, content: String) -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|err| format!("cannot resolve home dir: {err}"))?;
    let downloads = std::path::PathBuf::from(home).join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|err| format!("mkdir {}: {err}", downloads.display()))?;
    // Strip any path component from the filename — only the basename is allowed.
    let basename = std::path::Path::new(&filename)
        .file_name()
        .ok_or_else(|| "empty filename".to_string())?
        .to_string_lossy()
        .to_string();
    if basename.is_empty() || basename == "." || basename == ".." {
        return Err(format!("illegal filename: {filename}"));
    }
    let target = downloads.join(&basename);
    std::fs::write(&target, content).map_err(|err| format!("write {}: {err}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
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

// Returns the daemon's pid by matching command-line on bun.exe / node.exe.
// Win11 reparents schtasks-spawned processes under svchost so PID/parent
// chains break — command-line is the reliable signal. Returns None on
// non-Windows (the dashboard skips its pre/post check there). See PR3 #19.
#[tauri::command]
fn wechat_daemon_pid() -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$p = Get-CimInstance Win32_Process -Filter \"Name = 'bun.exe' OR Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'wechat-cc' } | Select-Object -First 1; if ($p) { $p.ProcessId }",
            ])
            .output()
            .ok()?;
        let s = String::from_utf8(output.stdout).ok()?;
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        trimmed.parse::<u32>().ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            wechat_cli_json,
            wechat_cli_json_via_file,
            wechat_cli_text,
            save_text_file,
            render_qr_svg,
            wechat_daemon_pid
        ])
        .run(tauri::generate_context!())
        .expect("error while running wechat-cc desktop");
}

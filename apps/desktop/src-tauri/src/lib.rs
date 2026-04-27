use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

#[tauri::command]
fn wechat_cli_json(args: Vec<String>) -> Result<Value, String> {
    let output = run_wechat_cli(args)?;
    serde_json::from_str(&output).map_err(|err| format!("invalid JSON from wechat-cc: {err}\n{output}"))
}

#[tauri::command]
fn wechat_cli_text(args: Vec<String>) -> Result<String, String> {
    run_wechat_cli(args)
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

fn run_wechat_cli(args: Vec<String>) -> Result<String, String> {
    let root = wechat_root()?;
    let cli = root.join("cli.ts");
    let bun = std::env::var("BUN_PATH").unwrap_or_else(|_| "bun".to_string());
    let output = Command::new(bun)
        .arg(cli)
        .args(args)
        .current_dir(&root)
        .output()
        .map_err(|err| format!("failed to run wechat-cc: {err}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn wechat_root() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("WECHAT_CC_ROOT") {
        return Ok(PathBuf::from(root));
    }

    let exe = std::env::current_exe().map_err(|err| format!("cannot locate executable: {err}"))?;
    for ancestor in exe.ancestors() {
        if has_cli(ancestor) {
            return Ok(ancestor.to_path_buf());
        }
    }

    let cwd = std::env::current_dir().map_err(|err| format!("cannot locate cwd: {err}"))?;
    for ancestor in cwd.ancestors() {
        if has_cli(ancestor) {
            return Ok(ancestor.to_path_buf());
        }
    }

    Err("WECHAT_CC_ROOT is not set and cli.ts was not found near the app".to_string())
}

fn has_cli(path: &Path) -> bool {
    path.join("cli.ts").exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![wechat_cli_json, wechat_cli_text, render_qr_svg])
        .run(tauri::generate_context!())
        .expect("error while running wechat-cc desktop");
}

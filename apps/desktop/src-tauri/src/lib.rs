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

// Order of search for the wechat-cc source root (containing cli.ts):
//   1. WECHAT_CC_ROOT env var (explicit override; used in dev + power users)
//   2. Tauri resource_dir/wechat-cc-src (when we bundle source as a resource)
//   3. ~/.local/share/wechat-cc      (recommended user-install location)
//   4. /opt/wechat-cc                (system-wide install)
//   5. /usr/share/wechat-cc          (distro packaging)
//   6. exe ancestors (dev: built binary lives inside the source tree)
//   7. cwd ancestors (dev: shim or `tauri dev` from arbitrary subdir)
fn wechat_root() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("WECHAT_CC_ROOT") {
        let p = PathBuf::from(root);
        if has_cli(&p) {
            return Ok(p);
        }
        return Err(format!("WECHAT_CC_ROOT points to {} but no cli.ts there", p.display()));
    }

    if let Some(home) = std::env::var_os("HOME") {
        let user_share = PathBuf::from(&home).join(".local/share/wechat-cc");
        if has_cli(&user_share) {
            return Ok(user_share);
        }
    }

    for sys_path in ["/opt/wechat-cc", "/usr/share/wechat-cc"] {
        let p = PathBuf::from(sys_path);
        if has_cli(&p) {
            return Ok(p);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            // Tauri bundled-resource layout: <exe>/../resources/wechat-cc-src
            let candidate = ancestor.join("resources").join("wechat-cc-src");
            if has_cli(&candidate) {
                return Ok(candidate);
            }
            if has_cli(ancestor) {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            if has_cli(ancestor) {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    Err(concat!(
        "wechat-cc source not found. Either set WECHAT_CC_ROOT, ",
        "or install the source at ~/.local/share/wechat-cc (git clone https://github.com/ggshr9/wechat-cc.git ~/.local/share/wechat-cc)."
    ).to_string())
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

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::Client;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use uuid::Uuid;

struct BackendEndpoint {
    base: String,
    token: String,
    client: Client,
}
struct BackendState(BackendEndpoint);
struct Sidecar(Mutex<Child>);

const SIDECAR_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STARTUP_DIAGNOSTICS: usize = 16 * 1024;

fn readiness_port(line: &str) -> Option<u16> {
    let message = serde_json::from_str::<Value>(line).ok()?;
    if message.get("ready").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let port = message.get("port").and_then(Value::as_u64)?;
    u16::try_from(port).ok().filter(|port| *port != 0)
}

fn append_diagnostic(buffer: &mut String, line: &str) {
    buffer.push_str(line);
    buffer.push('\n');
    if buffer.len() > MAX_STARTUP_DIAGNOSTICS {
        let excess = buffer.len() - MAX_STARTUP_DIAGNOSTICS;
        let boundary = buffer
            .char_indices()
            .find(|(index, _)| *index >= excess)
            .map(|(index, _)| index)
            .unwrap_or(buffer.len());
        buffer.drain(..boundary);
    }
}

fn startup_failure(
    child: &mut Child,
    stderr: thread::JoinHandle<Vec<u8>>,
    reason: &str,
    stdout: &str,
) -> String {
    let status = match child.try_wait() {
        Ok(Some(status)) => Some(status),
        _ => {
            let _ = child.kill();
            child.wait().ok()
        }
    };
    let stderr = stderr.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr);
    let status = status
        .map(|status| match status.code() {
            Some(code) => format!("exit code {code}"),
            None => "terminated by signal".to_string(),
        })
        .unwrap_or_else(|| "status unavailable".to_string());
    let mut details = Vec::new();
    if !stderr.trim().is_empty() {
        details.push(format!("stderr: {}", stderr.trim()));
    }
    if !stdout.trim().is_empty() {
        details.push(format!("stdout: {}", stdout.trim()));
    }
    if details.is_empty() {
        format!("{reason} ({status}; no startup output)")
    } else {
        format!("{reason} ({status}; {})", details.join("; "))
    }
}

#[tauri::command]
async fn backend_invoke(
    state: State<'_, BackendState>,
    command: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let endpoint = &state.0;
    let response = endpoint
        .client
        .post(format!("{}/invoke", endpoint.base))
        .header("x-meridian-token", &endpoint.token)
        .json(&json!({ "command": command, "args": args }))
        .send()
        .await
        .map_err(|e| format!("backend unavailable: {e}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("invalid backend response: {e}"))?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("backend command failed")
            .to_string());
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn backend_events(state: State<'_, BackendState>) -> Result<Vec<Value>, String> {
    let endpoint = &state.0;
    let response = endpoint
        .client
        .post(format!("{}/events", endpoint.base))
        .header("x-meridian-token", &endpoint.token)
        .send()
        .await
        .map_err(|e| format!("backend unavailable: {e}"))?;
    response
        .json()
        .await
        .map_err(|e| format!("invalid event response: {e}"))
}

/// 设置 macOS Dock 角标（到期未结算数）。count 为 0 时清除。
#[tauri::command]
fn set_dock_badge(app: tauri::AppHandle, count: i64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            use objc2_foundation::NSString;

            if let Some(mtm) = MainThreadMarker::new() {
                let app = NSApplication::sharedApplication(mtm);
                let tile = app.dockTile();
                if count > 0 {
                    let label = NSString::from_str(&count.to_string());
                    tile.setBadgeLabel(Some(&label));
                } else {
                    tile.setBadgeLabel(None);
                }
            }
        })
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, count);
        Ok(())
    }
}

/// 把主窗口带到前台并聚焦（通知点击、Dock 点击时调用）。
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// macOS 标题栏毛玻璃（vibrancy）。窗口需 transparent。
#[cfg(target_os = "macos")]
fn apply_vibrancy(window: &tauri::WebviewWindow) {
    use tauri::window::Effect;
    use tauri::window::EffectState;

    let _ = window.set_effects(Some(
        tauri::window::EffectsBuilder::new()
            .effect(Effect::Sidebar)
            .state(EffectState::Active)
            .build(),
    ));
}

fn application_data_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(|p| PathBuf::from(p).join("AppData").join("Roaming"))
            })
            .ok_or("could not resolve Windows roaming app-data directory")?;
        return Ok(base.join("脉络"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("could not resolve home directory")?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("脉络"));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local").join("share"))
            })
            .ok_or("could not resolve application data directory")?;
        Ok(data_home.join("脉络"))
    }
}

#[tauri::command]
fn application_data_dir() -> Result<String, String> {
    application_data_directory().map(|path| path.to_string_lossy().into_owned())
}

fn launch_sidecar(app: &tauri::AppHandle) -> Result<(Child, BackendEndpoint), String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let (node, script, cwd) = if cfg!(debug_assertions) {
        let root = manifest
            .parent()
            .ok_or("invalid project root")?
            .to_path_buf();
        let script = root.join("src").join("tauri").join("backend.mjs");
        let node = std::env::var_os("MERIDIAN_NODE_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        (node, script, root)
    } else {
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let root = resource_dir.join("sidecar").join("meridian");
        let script = root.join("src").join("tauri").join("backend.mjs");
        let node = resource_dir
            .join("sidecar")
            .join("runtime")
            .join("node.exe");
        (node, script, root)
    };
    if !script.exists() {
        return Err(format!("missing sidecar entry: {}", script.display()));
    }
    let data_dir = application_data_directory()?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("cannot create data directory: {e}"))?;
    let token = Uuid::new_v4().to_string();
    let mut child = Command::new(&node)
        .arg(&script)
        .current_dir(&cwd)
        .env("MERIDIAN_SIDECAR_TOKEN", &token)
        .env("MERIDIAN_USER_DATA_DIR", &data_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not launch Node sidecar ({}): {e}", node.display()))?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
    let stderr_reader = thread::spawn(move || {
        let mut reader = stderr;
        let mut output = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    output.extend_from_slice(&chunk[..size]);
                    if output.len() > MAX_STARTUP_DIAGNOSTICS {
                        let excess = output.len() - MAX_STARTUP_DIAGNOSTICS;
                        output.drain(..excess);
                    }
                }
            }
        }
        output
    });
    let (line_tx, line_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = line_tx.send(Ok(None));
                    break;
                }
                Ok(_) => {
                    let line = line.trim_end_matches(['\r', '\n']).to_string();
                    if line_tx.send(Ok(Some(line))).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = line_tx.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });

    let started = Instant::now();
    let mut startup_output = String::new();
    loop {
        let remaining = SIDECAR_STARTUP_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(startup_failure(
                &mut child,
                stderr_reader,
                "Node sidecar startup timed out before reporting readiness",
                &startup_output,
            ));
        }
        match line_rx.recv_timeout(remaining) {
            Ok(Ok(Some(line))) => {
                if let Some(port) = readiness_port(&line) {
                    return Ok((
                        child,
                        BackendEndpoint {
                            base: format!("http://127.0.0.1:{port}"),
                            token,
                            client: Client::new(),
                        },
                    ));
                }
                append_diagnostic(&mut startup_output, &line);
            }
            Ok(Ok(None)) => {
                return Err(startup_failure(
                    &mut child,
                    stderr_reader,
                    "Node sidecar closed stdout before reporting readiness",
                    &startup_output,
                ));
            }
            Ok(Err(error)) => {
                return Err(startup_failure(
                    &mut child,
                    stderr_reader,
                    &format!("could not read Node sidecar startup output: {error}"),
                    &startup_output,
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(startup_failure(
                    &mut child,
                    stderr_reader,
                    "Node sidecar startup timed out before reporting readiness",
                    &startup_output,
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(startup_failure(
                    &mut child,
                    stderr_reader,
                    "Node sidecar startup reader stopped before reporting readiness",
                    &startup_output,
                ));
            }
        }
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            backend_invoke,
            backend_events,
            application_data_dir,
            set_dock_badge,
            focus_main_window
        ])
        .setup(|app| {
            let (child, endpoint) = launch_sidecar(app.handle()).map_err(std::io::Error::other)?;
            app.manage(BackendState(endpoint));
            app.manage(Sidecar(Mutex::new(child)));
            // macOS 毛玻璃：主窗口用 Sidebar vibrancy
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                apply_vibrancy(&window);
            }
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build Meridian");
    app.run(|handle, event| {
        match event {
            tauri::RunEvent::Exit => {
                if let Some(sidecar) = handle.try_state::<Sidecar>() {
                    if let Ok(mut child) = sidecar.0.lock() {
                        let _ = child.kill();
                    }
                }
            }
            // macOS：点击 Dock 图标或通知时，把主窗口带到前台
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{append_diagnostic, readiness_port, MAX_STARTUP_DIAGNOSTICS};

    #[test]
    fn accepts_a_valid_sidecar_ready_frame() {
        assert_eq!(
            readiness_port(r#"{"ready":true,"host":"127.0.0.1","port":43210}"#),
            Some(43210)
        );
    }

    #[test]
    fn rejects_malformed_or_invalid_ready_ports() {
        assert_eq!(readiness_port("not json"), None);
        assert_eq!(readiness_port(r#"{"ready":false,"port":43210}"#), None);
        assert_eq!(readiness_port(r#"{"ready":true,"port":0}"#), None);
        assert_eq!(readiness_port(r#"{"ready":true,"port":65536}"#), None);
        assert_eq!(readiness_port(r#"{"ready":true,"port":"43210"}"#), None);
    }

    #[test]
    fn startup_diagnostics_keep_only_a_bounded_tail() {
        let mut diagnostics = String::new();
        append_diagnostic(&mut diagnostics, &"x".repeat(MAX_STARTUP_DIAGNOSTICS));
        append_diagnostic(&mut diagnostics, "latest diagnostic");

        assert!(diagnostics.len() <= MAX_STARTUP_DIAGNOSTICS);
        assert!(diagnostics.ends_with("latest diagnostic\n"));
    }
}

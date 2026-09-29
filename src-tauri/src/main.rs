#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::Client;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
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
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not launch Node sidecar ({}): {e}", node.display()))?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let reader = BufReader::new(stdout);
    let mut port = None;
    for line in reader.lines().take(200) {
        let line = line.map_err(|e| format!("sidecar startup read failed: {e}"))?;
        if let Ok(message) = serde_json::from_str::<Value>(&line) {
            if message.get("ready").and_then(Value::as_bool) == Some(true) {
                port = message
                    .get("port")
                    .and_then(Value::as_u64)
                    .map(|p| p as u16);
                if port.is_some() {
                    break;
                }
            }
        }
    }
    let port = port.ok_or_else(|| {
        let _ = child.kill();
        "Node sidecar exited before reporting readiness".to_string()
    })?;
    Ok((
        child,
        BackendEndpoint {
            base: format!("http://127.0.0.1:{port}"),
            token,
            client: Client::new(),
        },
    ))
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            backend_invoke,
            backend_events,
            application_data_dir
        ])
        .setup(|app| {
            let (child, endpoint) = launch_sidecar(app.handle()).map_err(std::io::Error::other)?;
            app.manage(BackendState(endpoint));
            app.manage(Sidecar(Mutex::new(child)));
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build Meridian");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(sidecar) = handle.try_state::<Sidecar>() {
                if let Ok(mut child) = sidecar.0.lock() {
                    let _ = child.kill();
                }
            }
        }
    });
}

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! MeOS desktop shell. The knowledge engine stays in the Node server; this
//! binary owns the window and the server's lifecycle: if nothing is listening
//! on the MeOS port it spawns `node packages/server/dist/main.js` and tears it
//! down again when the app exits. A server already running (e.g. `pnpm dev`)
//! is left untouched.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent};

const DEFAULT_PORT: u16 = 4321;

/// A server process we spawned (None when one was already running).
struct ManagedServer(Mutex<Option<Child>>);

fn server_port() -> u16 {
    std::env::var("MEOS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn server_reachable(port: u16) -> bool {
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// The self-contained runtime shipped inside a packaged app as a Tauri
/// resource (`bundle.resources`): a private Node, the vendored server, the web
/// UI and a pre-seeded embedding model. Absent in `tauri dev`.
struct Payload {
    node: PathBuf,
    entry: PathBuf,
    app_dir: PathBuf,
    web_dist: PathBuf,
    model_cache: PathBuf,
}

/// Resolve the bundled payload from the app's resource dir. Returns None in a
/// dev build, where no payload is bundled and the repo layout is used instead.
fn bundled_payload(app: &AppHandle) -> Option<Payload> {
    let payload = app.path().resource_dir().ok()?.join("payload");
    let entry = payload.join("app/server/dist/main.js");
    // The payload only exists in a packaged build; bail to the repo layout
    // otherwise so `tauri dev` keeps running the server from source.
    if !entry.exists() {
        return None;
    }
    Some(Payload {
        node: payload.join("runtime").join(if cfg!(windows) { "node.exe" } else { "node" }),
        entry,
        app_dir: payload.join("app"),
        web_dist: payload.join("app/web"),
        model_cache: payload.join("models"),
    })
}

/// Spawn the knowledge server. A packaged app runs its bundled Node against the
/// vendored server, redirecting the read-only resource bundle's data, model
/// cache and web assets to writable per-user dirs (the matching `MEOS_*` env
/// vars are read by the server). A dev build falls back to the repo layout and
/// a system `node`, both overridable via `MEOS_SERVER_ENTRY` / `MEOS_ROOT`.
fn spawn_server(app: &AppHandle) -> Option<Child> {
    let mut command;
    let label;
    if let Some(p) = bundled_payload(app) {
        let data_dir = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("data"))
            .unwrap_or_else(|_| p.app_dir.join("data"));
        let _ = std::fs::create_dir_all(&data_dir);

        command = Command::new(&p.node);
        command
            .arg(&p.entry)
            .current_dir(&p.app_dir)
            .env("MEOS_DATA_DIR", &data_dir)
            .env("MEOS_MODEL_CACHE", &p.model_cache)
            .env("MEOS_WEB_DIST", &p.web_dist);
        label = p.entry.display().to_string();
    } else {
        let entry = std::env::var("MEOS_SERVER_ENTRY")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../server/dist/main.js").to_string());
        let root = std::env::var("MEOS_ROOT")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../..").to_string());
        command = Command::new("node");
        command.arg(&entry).current_dir(&root);
        label = entry;
    }

    match command.env("MEOS_EXIT_WITH_PARENT", "1").spawn() {
        Ok(child) => {
            eprintln!("meos: started knowledge server ({label})");
            Some(child)
        }
        Err(error) => {
            eprintln!("meos: could not start knowledge server ({label}): {error}");
            None
        }
    }
}

/// SIGTERM first so the server closes the database cleanly; SIGKILL only if it
/// doesn't exit within a few seconds.
fn stop_server(mut child: Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg(child.id().to_string()).status();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let port = server_port();
            let child = if server_reachable(port) {
                eprintln!("meos: server already running on :{port}");
                None
            } else {
                spawn_server(app.handle())
            };

            // Give a freshly spawned server a moment to listen so the first
            // paint already has data; the UI polls and recovers regardless.
            if child.is_some() {
                let deadline = Instant::now() + Duration::from_secs(15);
                while Instant::now() < deadline && !server_reachable(port) {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }

            app.manage(ManagedServer(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building MeOS");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(server) = app_handle.try_state::<ManagedServer>() {
                if let Some(child) = server.0.lock().expect("server mutex poisoned").take() {
                    stop_server(child);
                }
            }
        }
    });
}

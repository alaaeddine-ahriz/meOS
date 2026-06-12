// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! MeOS desktop shell. The knowledge engine stays in the Node server; this
//! binary owns the window and the server's lifecycle: if nothing is listening
//! on the MeOS port it spawns `node packages/server/dist/main.js` and tears it
//! down again when the app exits. A server already running (e.g. `pnpm dev`)
//! is left untouched.

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

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

/// Entry point and working directory default to this repository's layout so a
/// locally built app works with zero configuration; both can be overridden
/// when the server lives elsewhere.
fn spawn_server() -> Option<Child> {
    let entry = std::env::var("MEOS_SERVER_ENTRY")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../server/dist/main.js").to_string());
    let root = std::env::var("MEOS_ROOT")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../..").to_string());

    match Command::new("node")
        .arg(&entry)
        .current_dir(&root)
        .env("MEOS_EXIT_WITH_PARENT", "1")
        .spawn()
    {
        Ok(child) => {
            eprintln!("meos: started knowledge server ({entry})");
            Some(child)
        }
        Err(error) => {
            eprintln!("meos: could not start `node {entry}`: {error}");
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
        .setup(|app| {
            let port = server_port();
            let child = if server_reachable(port) {
                eprintln!("meos: server already running on :{port}");
                None
            } else {
                spawn_server()
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

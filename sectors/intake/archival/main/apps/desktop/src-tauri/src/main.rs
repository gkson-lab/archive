// archival desktop. the window is a web ui; every action goes through one `api` command into
// the same service the cli and mcp server use. `archival-desktop mcp` runs the mcp server instead.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use archival_service::Service;
use serde_json::{json, Value};
use tauri::{Manager, RunEvent};

struct Launch(Option<String>);

static CONNECTED: std::sync::Once = std::sync::Once::new();

#[tauri::command]
async fn api(method: String, params: Value, svc: tauri::State<'_, Service>, launch: tauri::State<'_, Launch>) -> Result<Value, String> {
    // printed once so a launch check can tell the window loaded and reached the backend
    CONNECTED.call_once(|| println!("archival: ui connected"));
    if method == "app.launch" {
        return Ok(json!({ "open": launch.0 }));
    }
    svc.call(&method, params).await.map_err(|e| format!("{e:#}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|a| a == "mcp").unwrap_or(false) {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        rt.block_on(async {
            match Service::open(None) {
                Ok(svc) => {
                    svc.start_background();
                    if let Err(e) = archival_mcp::serve_stdio(svc).await {
                        eprintln!("archival mcp: {e:#}");
                    }
                }
                Err(e) => eprintln!("archival mcp: {e:#}"),
            }
        });
        return;
    }
    let open = args.iter().position(|a| a == "--open").and_then(|i| args.get(i + 1).cloned());

    // webkitgtk's dmabuf renderer shows a blank window on some gpus (often nvidia) and on
    // virtual displays. turn it off unless the user chose otherwise.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let svc = match Service::open(None) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("archival: couldn't open the vault: {e:#}");
            std::process::exit(1);
        }
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(svc.clone())
        .manage(Launch(open))
        .setup(|app| {
            let svc = app.state::<Service>().inner().clone();
            tauri::async_runtime::spawn(async move { svc.start_background() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api])
        .build(tauri::generate_context!())
        .expect("archival failed to start");

    app.run(move |_, ev| {
        if let RunEvent::Exit = ev {
            svc.shutdown();
        }
    });
}

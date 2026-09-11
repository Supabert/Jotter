mod actions;
mod attachments;
mod board;
mod db;
mod error;
mod images;
mod models;
mod notes;
mod settings;

use error::Result;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub struct AppState {
    pub conn: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub images_dir: PathBuf,
}

/// `Documents\Jotter\` — chosen over `%APPDATA%` so the notes sit somewhere the
/// user can see, copy, and back up without being told where to look.
///
/// `JOTTER_DATA_DIR` overrides it. That exists so the end-to-end suite drives
/// the real app against a throwaway database instead of writing test rows into
/// notes the user actually keeps — which matters more than usual here, because
/// the app has no delete with which to clean up after itself.
fn resolve_data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("JOTTER_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| error::Error::Msg(format!("cannot locate Documents: {e}")))?;
    Ok(docs.join("Jotter"))
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The Ctrl+Alt+N window: frameless, always on top, no taskbar entry. Toggling
/// rather than always-creating means a second press dismisses it, which is what
/// a capture hotkey should do when it fires by reflex.
fn toggle_capture(app: &tauri::AppHandle) {
    // Off the main thread, always. `build()` blocks until the event loop has
    // created the webview, so calling it FROM the event loop — which is where
    // a synchronous command and a tray menu handler both run — deadlocks: the
    // frame appears, the navigation never happens, and the window sits on
    // about:blank while the whole app stops answering. Tauri's window handles
    // are thread-safe, so the work simply moves off it.
    let handle = app.clone();
    std::thread::spawn(move || toggle_capture_blocking(&handle));
}

fn toggle_capture_blocking(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let visible = w.is_visible().unwrap_or(false);
        if visible {
            let _ = w.emit_to("capture", "capture:flush", ());
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.emit_to("capture", "capture:focus", ());
        }
        return;
    }

    let built = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html".into()))
        .title("Jotter — capture")
        .inner_size(560.0, 240.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .resizable(false)
        .visible(true)
        .build();

    match built {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => eprintln!("jotter: could not open the capture window: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be registered before anything else: a second launch should surface
    // the window that already exists, not start a rival process holding the
    // same SQLite file.
    //
    // The guard exists for that one reason, so it lifts when the reason does.
    // A run pointed at its own `JOTTER_DATA_DIR` opens a different database and
    // is not a rival for anything — and blocking it means a test or a demo can
    // only run by first closing the app the user is actually using.
    #[cfg(desktop)]
    if std::env::var_os("JOTTER_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ))
        .plugin(build_shortcut_plugin())
        .setup(|app| {
            let handle = app.handle().clone();

            let data_dir = resolve_data_dir(&handle)?;
            let images_dir = data_dir.join("images");
            std::fs::create_dir_all(&images_dir)?;

            let conn = db::open(&data_dir.join("jotter.db"))?;
            db::seed_if_empty(&conn)?;
            db::seed_board_if_empty(&conn)?;

            // Read before the connection is handed to the managed state, so a
            // hotkey the user rebound is the one that comes back after a
            // restart rather than the default silently reclaiming it.
            let hotkey = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'hotkey'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap_or_else(|_| DEFAULT_HOTKEY.to_string());

            app.manage(AppState {
                conn: Mutex::new(conn),
                data_dir,
                images_dir,
            });

            // Linked files are outside the asset scope by definition, so the
            // grants have to be replayed before anything can preview one.
            let _ = attachments::allow_linked(&handle);

            register_hotkey(&handle, &hotkey);
            build_tray(&handle)?;

            // Closing the window parks the app in the tray instead of quitting,
            // so reopening is instant and no note is ever mid-flight at exit.
            if let Some(main) = app.get_webview_window("main") {
                // The autostart entry launches with `--tray`. Starting with
                // Windows should mean the tray icon and the hotkey are armed,
                // not that a window lands on top of whatever the machine was
                // opening. The window is configured visible for every other
                // launch, so this is the one case that hides it.
                if std::env::args().any(|a| a == "--tray") {
                    let _ = main.hide();
                }

                let h = handle.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window("main") {
                            let _ = w.emit("app:flush", ());
                            let _ = w.hide();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes::list_notes,
            notes::get_note,
            notes::create_note,
            notes::save_note,
            notes::set_note_label,
            notes::set_note_pinned,
            notes::set_note_archived,
            notes::delete_note,
            notes::search_notes,
            actions::list_actions,
            actions::create_action,
            actions::set_action_done,
            actions::set_action_due,
            actions::set_action_text,
            actions::set_action_archived,
            actions::set_action_notes,
            actions::set_action_start,
            actions::set_action_span,
            actions::move_action_project,
            attachments::save_attachment,
            attachments::link_paths,
            attachments::clipboard_file_paths,
            attachments::open_linked_path,
            attachments::list_attachments,
            attachments::delete_attachment,
            attachments::open_attachment,
            attachments::reveal_attachment,
            actions::delete_action,
            actions::reorder_actions,
            actions::done_anchors,
            board::list_projects,
            board::create_project,
            board::update_project,
            board::reorder_projects,
            board::set_action_project,
            board::list_stages,
            board::create_stage,
            board::update_stage,
            board::delete_stage,
            board::reorder_stages,
            board::move_action,
            images::save_image,
            images::image_path,
            settings::get_settings,
            settings::set_setting,
            settings::list_labels,
            settings::create_label,
            settings::update_label,
            settings::reorder_labels,
            settings::data_dir,
            settings::backup_now,
            quit_app,
            open_capture,
            rebind_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jotter");
}

fn build_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::ShortcutState;

    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_capture(app);
            }
        })
        .build()
}

/// Windows spelling on purpose: this app only runs here, and `CmdOrCtrl` is a
/// cross-platform token that would be shown to the user as something no Windows
/// keyboard has a key for.
const DEFAULT_HOTKEY: &str = "Ctrl+Alt+N";

fn register_hotkey(app: &tauri::AppHandle, accelerator: &str) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Err(e) = app.global_shortcut().register(accelerator) {
        // A hotkey another app already owns is a real condition, not a crash:
        // Jotter still works, it just cannot be summoned until it is rebound.
        eprintln!("jotter: could not register {accelerator}: {e}");
    }
}

/// Rebinding is all-or-nothing. Dropping the old shortcut first and then
/// failing on the new one would leave the app with no way to be summoned at
/// all — the worst outcome of a settings edit — so the previous accelerator is
/// put back before the error is reported.
#[tauri::command]
fn rebind_hotkey(
    app: tauri::AppHandle,
    state: State<AppState>,
    accelerator: String,
) -> std::result::Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let previous = {
        let conn = state.conn.lock().unwrap();
        conn.query_row("SELECT value FROM settings WHERE key = 'hotkey'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_else(|_| DEFAULT_HOTKEY.to_string())
    };

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    match gs.register(accelerator.as_str()) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = gs.register(previous.as_str());
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn open_capture(app: tauri::AppHandle) {
    toggle_capture(&app);
}

/// The only real exit. Reached from the tray menu and the command palette —
/// never from the window's close button, which parks to tray instead.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn build_tray(app: &tauri::AppHandle) -> Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Jotter", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Quick capture\tCtrl+Alt+N", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &capture, &sep, &quit])?;

    TrayIconBuilder::with_id("jotter-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Jotter")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "capture" => toggle_capture(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

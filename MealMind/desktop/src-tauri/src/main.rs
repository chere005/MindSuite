// Desktop shell — the same web export in a native window. All behavior
// lives in the shared JS; this shell opens the window and carries the four
// commands app sign-in needs (src/signin.rs): the page signs in through the
// suite's /account/app/ in the system browser and the shell catches the
// return on a one-shot 127.0.0.1 listener. The app name comes from
// tauri.conf.json.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod signin;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// The sign-in in flight: its listener until `signin_wait` takes it, and the flag that ends its wait.
#[derive(Default)]
struct SignIn {
    pending: Mutex<Option<signin::Pending>>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

fn stopped<T>(_: PoisonError<T>) -> String {
    "the sign-in stopped".to_string()
}

/// Start listening for the return of a sign-in that uses `state`; answers the port. An earlier sign-in is cancelled.
#[tauri::command]
fn signin_listen(state: String, s: State<'_, SignIn>) -> Result<u16, String> {
    if let Some(flag) = s.cancel.lock().map_err(stopped)?.take() {
        flag.store(true, Ordering::SeqCst);
    }
    s.pending.lock().map_err(stopped)?.take();
    let p = signin::listen(&state)?;
    let port = p.port();
    *s.cancel.lock().map_err(stopped)? = Some(p.canceller());
    *s.pending.lock().map_err(stopped)? = Some(p);
    Ok(port)
}

/// Open one of the suite's account pages in the system browser.
#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    signin::open_in_browser(&url)
}

/// Wait (up to ten minutes) for the return. The query string of the request that carried our state, or None when cancelled.
#[tauri::command]
async fn signin_wait(app: AppHandle, s: State<'_, SignIn>) -> Result<Option<String>, String> {
    let taken = s.pending.lock().map_err(stopped)?.take();
    let p = taken.ok_or_else(|| "no sign-in is waiting".to_string())?;
    // The product name ("CalMind"), not the crate's: it is what the person sees on the page the browser ends on.
    let name = app.config().product_name.clone().unwrap_or_else(|| app.package_info().name.clone());
    let out = tauri::async_runtime::spawn_blocking(move || signin::wait(p, Duration::from_secs(600), &name))
        .await
        .map_err(|_| "the sign-in stopped".to_string())??;
    if out.is_some() {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
    Ok(out)
}

/// Stop waiting: the waiting call answers None.
#[tauri::command]
fn signin_cancel(s: State<'_, SignIn>) -> Result<(), String> {
    if let Some(flag) = s.cancel.lock().map_err(stopped)?.as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
    s.pending.lock().map_err(stopped)?.take();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(SignIn::default())
        .invoke_handler(tauri::generate_handler![signin_listen, open_in_browser, signin_wait, signin_cancel])
        .run(tauri::generate_context!())
        .expect("error while running the desktop shell");
}

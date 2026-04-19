// Entry point: boots the tokio runtime for the server and (optionally)
// the tao event loop for the tray icon on the main thread.

// Suppress the console window on Windows release builds when the tray
// feature is enabled. In debug we keep the console so logs are visible.
#![cfg_attr(
    all(windows, not(debug_assertions), feature = "tray"),
    windows_subsystem = "windows"
)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod admin;
mod applog;
mod channel;
mod config;
mod db;
mod http;
mod message;
mod metrics;
mod net;
mod state;
mod user;
mod ws;

#[cfg(feature = "tray")]
mod tray;

use std::error::Error;
use std::sync::Arc;

use state::AppState;
use tokio::sync::oneshot;

type BoxErr = Box<dyn Error + Send + Sync + 'static>;

fn main() -> Result<(), BoxErr> {
    // Build a tightly-tuned Tokio runtime.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(num_workers())
        .max_blocking_threads(2)
        .thread_stack_size(256 * 1024)
        .enable_io()
        .enable_time()
        .build()?;

    // Shared state lives for the life of the process.
    let state = runtime.block_on(AppState::bootstrap())?;

    // Start the server on the runtime. Non-blocking: returns the port.
    let server_ready_tx: oneshot::Sender<u16>;
    let server_ready_rx: oneshot::Receiver<u16>;
    (server_ready_tx, server_ready_rx) = oneshot::channel();

    let server_state = Arc::clone(&state);
    runtime.spawn(async move {
        if let Err(e) = http::serve(server_state, server_ready_tx).await {
            eprintln!("[fatal] server error: {e}");
            std::process::exit(1);
        }
    });

    // Block here until the server is actually bound.
    let port = runtime.block_on(async move { server_ready_rx.await })?;

    applog::log(format_args!("server listening on port {port}"));
    net::print_banner(port, &net::lan_addresses(), &state);

    // Auto-open the browser on the host when running the packaged build.
    if !std::env::args().any(|a| a == "--no-browser")
        && std::env::var("NO_BROWSER").unwrap_or_default() != "1"
    {
        let _ = opener::open(format!("https://localhost:{port}"));
    }

    // ---- Either run the tray loop on the main thread, or just park here.
    #[cfg(feature = "tray")]
    {
        // The tokio runtime must outlive the tray event loop. Leak it so
        // its worker threads keep the server alive; process::exit reclaims
        // everything when the user clicks Quit.
        Box::leak(Box::new(runtime));
        // tao::EventLoop MUST run on the main thread; tokio runs server.
        tray::run_event_loop(state, port);
        Ok(())
    }

    #[cfg(not(feature = "tray"))]
    {
        // Headless console mode: wait for Ctrl+C.
        runtime.block_on(async {
            let _ = tokio::signal::ctrl_c().await;
            println!("\n  Shutting down…");
        });
        Ok(())
    }
}

fn num_workers() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().min(4).max(1))
        .unwrap_or(2)
}

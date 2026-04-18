//! System tray: icon, menu, tooltip. Runs on the main thread.
//!
//! On Linux this requires GTK 3 development headers. The CI builds pass
//! `--no-default-features` on Linux to produce a headless console binary.

use std::sync::Arc;

use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    Icon, TrayIconBuilder,
};

use crate::state::AppState;

pub fn run_event_loop(state: Arc<AppState>, port: u16) {
    let event_loop = EventLoopBuilder::new().build();

    let menu = Menu::new();
    let open_chat = MenuItem::new("Open chat in browser", true, None);
    let copy_link = MenuItem::new("Copy LAN link", true, None);
    let open_admin = MenuItem::new("Open admin dashboard", true, None);
    let quit = MenuItem::new("Quit LanChat", true, None);

    let _ = menu.append(&open_chat);
    let _ = menu.append(&copy_link);
    let _ = menu.append(&open_admin);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&quit);

    let icon = build_icon();

    let tray_result = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_icon(icon)
        .with_tooltip(format!("LanChat • port {port}"))
        .build();

    // Keep the tray alive for the whole loop.
    let _tray = match tray_result {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[warn] tray icon init failed: {e}. Running headless.");
            // Park the main thread; tokio workers keep the server alive.
            std::thread::park();
            return;
        }
    };

    let open_chat_id = open_chat.id().clone();
    let copy_link_id = copy_link.id().clone();
    let open_admin_id = open_admin.id().clone();
    let quit_id = quit.id().clone();

    let lan_ips = crate::net::lan_addresses();
    let lan_url = lan_ips
        .first()
        .map(|ip| format!("http://{ip}:{port}"))
        .unwrap_or_else(|| format!("http://localhost:{port}"));
    let local_url = format!("http://localhost:{port}");

    let menu_channel = MenuEvent::receiver();

    event_loop.run(move |_event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;

        while let Ok(ev) = menu_channel.try_recv() {
            if ev.id == open_chat_id {
                let _ = opener::open(&local_url);
            } else if ev.id == copy_link_id {
                if let Ok(mut cb) = arboard::Clipboard::new() {
                    let _ = cb.set_text(lan_url.clone());
                }
            } else if ev.id == open_admin_id {
                let token = state.config.read().map(|c| c.admin_token.clone()).unwrap_or_default();
                let url = format!("{local_url}/admin?token={}", url_safe(&token));
                let _ = opener::open(&url);
            } else if ev.id == quit_id {
                *control_flow = ControlFlow::Exit;
                std::process::exit(0);
            }
        }
    });
}

/// Build a 32×32 RGBA indigo-gradient icon with a white "L".
fn build_icon() -> Icon {
    const N: usize = 32;
    let mut buf = Vec::with_capacity(N * N * 4);
    for y in 0..N {
        for x in 0..N {
            let (r, g, b) = if is_letter_l(x, y) {
                (255u8, 255u8, 255u8)
            } else {
                let t = (x + y) as u32 * 255 / 62;
                let r = 80u8.saturating_add((t / 4) as u8);
                let g = 70u8.saturating_add((t / 6) as u8);
                let b = 200u8.saturating_add((t / 10).min(55) as u8);
                (r, g, b)
            };
            buf.extend_from_slice(&[r, g, b, 255]);
        }
    }
    Icon::from_rgba(buf, N as u32, N as u32).expect("valid icon dimensions")
}

fn is_letter_l(x: usize, y: usize) -> bool {
    let vert = (9..=12).contains(&x) && (7..=24).contains(&y);
    let bot = (21..=24).contains(&y) && (9..=22).contains(&x);
    vert || bot
}

fn url_safe(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

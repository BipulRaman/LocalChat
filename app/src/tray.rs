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

pub fn run_event_loop(_state: Arc<AppState>, port: u16) {
    let event_loop = EventLoopBuilder::new().build();

    let menu = Menu::new();
    let open_chat = MenuItem::new("Open chat in browser", true, None);
    let copy_link = MenuItem::new("Copy LAN link", true, None);
    let open_admin = MenuItem::new("Open admin dashboard", true, None);
    let quit = MenuItem::new("Quit LocalChat", true, None);

    let _ = menu.append(&open_chat);
    let _ = menu.append(&copy_link);
    let _ = menu.append(&open_admin);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&quit);

    let icon = build_icon();

    let tray_result = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_icon(icon)
        .with_tooltip(format!("LocalChat • port {port}"))
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
        .map(|ip| format!("https://{ip}:{port}"))
        .unwrap_or_else(|| format!("https://localhost:{port}"));
    let local_url = format!("https://localhost:{port}");

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
                let url = format!("{local_url}/admin");
                let _ = opener::open(&url);
            } else if ev.id == quit_id {
                *control_flow = ControlFlow::Exit;
                std::process::exit(0);
            }
        }
    });
}

/// Build a 32×32 RGBA indigo→violet gradient icon with a white speech
/// bubble and three indigo dots (matches the web/tray branding).
fn build_icon() -> Icon {
    const N: i32 = 32;
    let mut buf = Vec::with_capacity((N * N * 4) as usize);
    for y in 0..N {
        for x in 0..N {
            let (r, g, b) = if in_dot(x, y) {
                (99u8, 102u8, 241u8) // indigo dots on the white bubble
            } else if in_bubble(x, y) {
                (255u8, 255u8, 255u8)
            } else {
                // Background: indigo (#6366f1) → violet (#8b5cf6) diagonal gradient.
                let t = ((x + y) as f32 / 62.0).clamp(0.0, 1.0);
                let lerp = |a: f32, b: f32| (a + (b - a) * t) as u8;
                (lerp(99.0, 139.0), lerp(102.0, 92.0), lerp(241.0, 246.0))
            };
            buf.extend_from_slice(&[r, g, b, 255]);
        }
    }
    Icon::from_rgba(buf, N as u32, N as u32).expect("valid icon dimensions")
}

/// Rounded-rect speech bubble (7..=24 × 7..=20, corner radius 3) with a
/// triangular tail pointing down to (15, 23).
fn in_bubble(x: i32, y: i32) -> bool {
    // Triangular tail below the bubble body.
    if (21..=23).contains(&y) {
        let t = 23 - y; // 2,1,0 for y=21,22,23
        return (15 - t..=15 + t).contains(&x);
    }
    // Bubble body (rounded rect).
    if !(7..=24).contains(&x) || !(7..=20).contains(&y) {
        return false;
    }
    let corner = |cx: i32, cy: i32| {
        let (dx, dy) = (x - cx, y - cy);
        dx * dx + dy * dy <= 9
    };
    if x < 10 && y < 10 {
        return corner(10, 10);
    }
    if x > 21 && y < 10 {
        return corner(21, 10);
    }
    if x < 10 && y > 17 {
        return corner(10, 17);
    }
    if x > 21 && y > 17 {
        return corner(21, 17);
    }
    true
}

/// Three 1.5px-radius dots inside the bubble at y=13.
fn in_dot(x: i32, y: i32) -> bool {
    const DOTS: [(i32, i32); 3] = [(13, 13), (16, 13), (19, 13)];
    DOTS.iter().any(|&(dx, dy)| {
        let (a, b) = (x - dx, y - dy);
        a * a + b * b <= 2
    })
}

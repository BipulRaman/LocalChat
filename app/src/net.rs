//! Networking helpers: port picking + LAN IP discovery + banner.

use std::net::{IpAddr, TcpListener};

/// Memorable, easy-to-type ports tried in order. 443 is first so
/// URLs can drop the port suffix when running elevated / as a service.
/// Falls through to high ports that never need admin rights.
pub const PREFERRED_PORTS: &[u16] =
    &[443, 5000, 5050, 5555, 8443, 8080, 8000, 8888, 3000, 4000, 7000, 9000];

/// Try a specific port; return Some(listener) if free.
fn try_bind(port: u16) -> Option<TcpListener> {
    TcpListener::bind(("0.0.0.0", port)).ok()
}

/// Pick a port. If `requested` is Some, try it first; on failure fall
/// back to the preferred list, then an OS-assigned ephemeral port.
/// Never errors unless every single attempt fails (vanishingly unlikely).
pub fn pick_port(requested: Option<u16>) -> std::io::Result<u16> {
    if let Some(p) = requested {
        if let Some(l) = try_bind(p) {
            drop(l);
            return Ok(p);
        }
        eprintln!("[warn] requested port {p} is unavailable, falling back…");
    }

    for &p in PREFERRED_PORTS {
        if let Some(l) = try_bind(p) {
            drop(l);
            return Ok(p);
        }
    }

    // Last resort: OS assigns an ephemeral port.
    let l = TcpListener::bind(("0.0.0.0", 0))?;
    let port = l.local_addr()?.port();
    drop(l);
    Ok(port)
}

/// All non-loopback IPv4 addresses for this host.
pub fn lan_addresses() -> Vec<String> {
    match local_ip_address::list_afinet_netifas() {
        Ok(list) => list
            .into_iter()
            .filter_map(|(_, ip)| match ip {
                IpAddr::V4(v) if !v.is_loopback() && !v.is_link_local() => {
                    Some(v.to_string())
                }
                _ => None,
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub fn print_banner(port: u16, addrs: &[String], state: &std::sync::Arc<crate::state::AppState>) {
    println!();
    println!("  ╔══════════════════════════════════════════════════════════╗");
    println!("  ║   LocalChat — LAN Instant Messenger                       ║");
    println!("  ╚══════════════════════════════════════════════════════════╝");
    println!();
    println!("  ✅  Server running. Keep this window / tray icon alive.");
    println!();
    println!("  💻  This computer:   https://localhost:{port}");
    if addrs.is_empty() {
        println!("  📡  LAN access:      (no LAN interface detected)");
    } else {
        for (i, ip) in addrs.iter().enumerate() {
            let label = if i == 0 {
                "  📡  LAN access:     "
            } else {
                "                      "
            };
            println!("{label}https://{ip}:{port}");
        }
    }
    println!();
    println!("  🔒  HTTPS uses a self-signed certificate. Accept the browser warning");
    println!("      once per device — required for mic/camera + E2EE.");
    println!();
    println!("  📁  Data folder:     {}", state.app_root.display());
    println!("  📝  Log file:        {}", state.logs_dir.join("localchat.log").display());
    println!("  🔑  Admin token:     {}", state.config.read().unwrap().admin_token);
    println!();
    println!("  Share the LAN link above with people on the same Wi-Fi.");
    println!();
}

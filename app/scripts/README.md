# LocalChat helper scripts

PowerShell helpers for running LocalChat with a real Let's Encrypt
certificate on a LAN-only deployment. Tested on Windows 11 with
PowerShell 5.1+ and 7.x.

All scripts read configuration from `config.ps1` (create from
`config.sample.ps1`). `config.ps1` is gitignored — your token stays
local.

Goal: a green-padlock `https://your.domain/` pointing at LocalChat on
your LAN, with zero inbound ports opened (DNS-01 challenge).
Estimated first-time setup: **~15 minutes**.

## Files

| Script | Purpose |
| --- | --- |
| `config.sample.ps1`        | Copy to `config.ps1` and fill in. |
| `install-lego.ps1`         | Installs `lego` via winget (one-time). |
| `issue-cert.ps1`           | First-time cert issue from Let's Encrypt (DNS-01). |
| `renew-cert.ps1`           | Renew-if-needed + restart server. |
| `install-renewal-task.ps1` | Registers a weekly scheduled task for `renew-cert.ps1`. |
| `run-localchat.ps1`        | Stops any existing localchat, launches a fresh one. |

---

## Prerequisites

- A domain you control (example: `im.bipul.in`).
- Domain DNS managed by **Cloudflare** (free plan is fine).
- `localchat.exe` built in release mode:
  ```powershell
  cd d:\GitHub\LANMsg
  cargo build --release
  ```

---

## Step 1 — Point the domain at this machine

Find the LAN IP (look for `192.168.*`):

```powershell
ipconfig | Select-String "IPv4"
```

In Cloudflare dashboard → your zone → **DNS → Records**:

| Type | Name | Content | Proxy | TTL |
| ---- | ---- | ------- | ----- | --- |
| A    | `im` (or `@`) | `192.168.29.65` | **DNS only** (gray cloud) | Auto |

> Gray cloud is required: Cloudflare's proxy can't reach a private IP.

Verify:

```powershell
Resolve-DnsName im.bipul.in -Type A
```

---

## Step 2 — Create a Cloudflare API token

Cloudflare → **My Profile → API Tokens → Create Token** → *Custom*.

| Field            | Value                                     |
| ---------------- | ----------------------------------------- |
| Token name       | `lego-dns01-localchat`                    |
| Permissions      | **Zone → DNS → Edit**                     |
| Zone resources   | **Include → Specific zone →** your zone   |

Create → copy the token (shown once).

---

## Step 3 — Fill in `config.ps1`

```powershell
cd d:\GitHub\LANMsg\scripts
Copy-Item config.sample.ps1 config.ps1 -ErrorAction SilentlyContinue
notepad config.ps1
```

```powershell
$Domain             = "im.bipul.in"
$Email              = "you@example.com"
$CloudflareApiToken = "cf-..."            # from step 2
$TlsDir             = Join-Path $env:APPDATA "LocalChat\tls"
$LocalChatExe       = "d:\GitHub\LANMsg\target\release\localchat.exe"
```

---

## Step 4 — Install `lego`

One-time:

```powershell
.\install-lego.ps1
```

Close and reopen PowerShell so `lego` is on PATH, then verify:

```powershell
lego --version
```

---

## Step 5 — Issue the first certificate

```powershell
.\issue-cert.ps1
```

What it does:

1. Calls `lego` with the Cloudflare DNS provider + your token.
2. Creates a temporary `_acme-challenge.<domain>` TXT record, waits
   for Let's Encrypt to verify it, then removes it.
3. Writes `cert.pem` + `key.pem` into `$TlsDir`
   (default `%APPDATA%\LocalChat\tls\`).

Common errors:

- `unauthenticated` → token scope wrong; must be **Zone.DNS: Edit**
  on the correct zone.
- Rate-limit while iterating → add
  `-server https://acme-staging-v02.api.letsencrypt.org/directory`
  to the `lego` command in `issue-cert.ps1` for testing.

---

## Step 6 — Run LocalChat

Port 443 is privileged on Windows — run PowerShell **as administrator**:

```powershell
cd d:\GitHub\LANMsg\scripts
.\run-localchat.ps1
```

LocalChat picks up `cert.pem` + `key.pem` from `$TlsDir` automatically.
It binds to **443** if available, else falls back to 5000, else any
free port (watch the console output).

Open `https://im.bipul.in/` — green padlock.

> Windows Firewall may prompt on first 443 bind — allow **Private**
> networks only.

---

## Step 7 — Automatic renewal

Let's Encrypt certs last 90 days. Register the weekly task (still in
an elevated PowerShell):

```powershell
.\install-renewal-task.ps1
```

This creates a scheduled task **LocalChat Cert Renewal** that runs
`renew-cert.ps1` weekly. The renewal script:

1. `lego renew --days 30` — no-op unless expiring within 30 days.
2. If a new cert was written, calls `run-localchat.ps1` to reload.

Force a dry run:

```powershell
.\renew-cert.ps1
```

Inspect the task:

```powershell
Get-ScheduledTask -TaskName "LocalChat Cert Renewal" | Get-ScheduledTaskInfo
```

---

## File locations

| What              | Path                                             |
| ----------------- | ------------------------------------------------ |
| Certificate       | `%APPDATA%\LocalChat\tls\cert.pem`               |
| Private key       | `%APPDATA%\LocalChat\tls\key.pem`                |
| lego account data | `%APPDATA%\LocalChat\tls\.lego\`                 |
| Script config     | `~\scripts\config.ps1`            |
| Release binary    | `~\target\release\localchat.exe`  |

---

## Rotating the Cloudflare token

If the token leaks:

1. Cloudflare → **API Tokens** → find the token → **Roll** or **Delete**.
2. Update `$CloudflareApiToken` in `config.ps1`.
3. Next `renew-cert.ps1` run uses the new value.

---

## Uninstall

```powershell
Unregister-ScheduledTask -TaskName "LocalChat Cert Renewal" -Confirm:$false
Remove-Item "$env:APPDATA\LocalChat\tls\cert.pem", `
            "$env:APPDATA\LocalChat\tls\key.pem"
```

LocalChat will regenerate a self-signed cert on next start.

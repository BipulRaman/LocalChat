# Renew cert if within 30 days of expiry, then restart LocalChat.
# Safe to run weekly — no-op when cert is still fresh.

. (Join-Path $PSScriptRoot "_load-config.ps1")

$env:CLOUDFLARE_DNS_API_TOKEN = $CloudflareApiToken

Write-Host "Checking renewal for $Domain ..." -ForegroundColor Cyan
& lego `
    --email $Email `
    --domains $Domain `
    --dns cloudflare `
    --path $TlsDir `
    renew --days 30

if ($LASTEXITCODE -ne 0) {
    Write-Error "lego renew failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

# Always copy — copying the same file is cheap, and guarantees cert.pem
# matches what lego currently thinks is valid.
$crt = Join-Path $TlsDir "certificates\$Domain.crt"
$key = Join-Path $TlsDir "certificates\$Domain.key"
Copy-Item $crt (Join-Path $TlsDir "cert.pem") -Force
Copy-Item $key (Join-Path $TlsDir "key.pem")  -Force

# Restart LocalChat so it picks up the (possibly) new cert.
& (Join-Path $PSScriptRoot "run-localchat.ps1")

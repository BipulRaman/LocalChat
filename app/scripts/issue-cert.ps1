# First-time certificate issuance via Let's Encrypt DNS-01 (Cloudflare).
# Run this once, then use renew-cert.ps1 afterwards.

. (Join-Path $PSScriptRoot "_load-config.ps1")

$env:CLOUDFLARE_DNS_API_TOKEN = $CloudflareApiToken

Write-Host "Issuing cert for $Domain ..." -ForegroundColor Cyan
& lego `
    --email $Email `
    --domains $Domain `
    --dns cloudflare `
    --path $TlsDir `
    --accept-tos `
    run

if ($LASTEXITCODE -ne 0) {
    Write-Error "lego failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$crt = Join-Path $TlsDir "certificates\$Domain.crt"
$key = Join-Path $TlsDir "certificates\$Domain.key"
if (-not (Test-Path $crt) -or -not (Test-Path $key)) {
    Write-Error "Cert files not found at expected paths:`n  $crt`n  $key"
    exit 1
}

# Back up any existing self-signed cert, then install the LE cert.
$certOut = Join-Path $TlsDir "cert.pem"
$keyOut  = Join-Path $TlsDir "key.pem"
if (Test-Path $certOut) { Move-Item $certOut "$certOut.self.bak" -Force }
if (Test-Path $keyOut)  { Move-Item $keyOut  "$keyOut.self.bak"  -Force }

Copy-Item $crt $certOut -Force
Copy-Item $key $keyOut  -Force

Write-Host "`nCert installed:" -ForegroundColor Green
Write-Host "  $certOut"
Write-Host "  $keyOut"
Write-Host "`nRestart LocalChat to pick up the new cert. Open https://$Domain" -ForegroundColor Green

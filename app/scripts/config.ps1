# LocalChat helper script config — copy to config.ps1 and fill in.
# config.ps1 is gitignored; this sample is safe to commit.

# The domain you've pointed to this machine's LAN IP via DNS.
$Domain = "im.bipul.in"

# Email used for Let's Encrypt account registration + expiry warnings.
$Email = "mail@bipul.in"

# Cloudflare API token with "Zone.DNS: Edit" for the zone of $Domain.
# Create at https://dash.cloudflare.com/profile/api-tokens
$CloudflareApiToken = "###"

# Where LocalChat reads its TLS cert. Defaults to %APPDATA%\LocalChat\tls.
$TlsDir = Join-Path $env:APPDATA "LocalChat\tls"

# Path to the compiled localchat.exe (release build recommended).
$LocalChatExe = "d:\GitHub\LANMsg\target\release\localchat.exe"

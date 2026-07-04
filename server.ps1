# FamilyVoiceAgent - tiny static file server (no dependencies)
# Speech recognition needs a secure context (localhost), so we serve
# the app over http://localhost instead of opening index.html directly.
param(
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".md"   = "text/plain; charset=utf-8"
    ".txt"  = "text/plain; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".ico"  = "image/x-icon"
    ".mp3"  = "audio/mpeg"
    ".wav"  = "audio/wav"
}

# find a free port starting at $Port
$listener = $null
$maxPort = $Port + 10
while ($true) {
    try {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$Port/")
        $listener.Start()
        break
    } catch {
        try { if ($listener) { $listener.Close() } } catch {}
        if ($Port -ge $maxPort) {
            Write-Host "ERROR: could not bind any port between $($maxPort-10) and $maxPort."
            Write-Host $_
            exit 1
        }
        $Port++
    }
}

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  ============================================="
Write-Host "   FamilyVoiceAgent is running at:  $url"
Write-Host "   Keep this window open while chatting."
Write-Host "   Close this window (or Ctrl+C) to stop."
Write-Host "  ============================================="
Write-Host ""

if (-not $NoBrowser) {
    try { Start-Process $url } catch {}
}

while ($listener.IsListening) {
    try { $ctx = $listener.GetContext() } catch { break }
    try {
        $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
        if ($path -eq "/") { $path = "/index.html" }
        $file = Join-Path $root ($path.TrimStart("/") -replace "/", "\")
        $full = [System.IO.Path]::GetFullPath($file)

        if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $full -PathType Leaf)) {
            $ctx.Response.StatusCode = 404
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
        } else {
            $ext = [System.IO.Path]::GetExtension($full).ToLower()
            $ct = $mime[$ext]
            if (-not $ct) { $ct = "application/octet-stream" }
            $ctx.Response.ContentType = $ct
            $bytes = [System.IO.File]::ReadAllBytes($full)
        }
        $ctx.Response.Headers.Add("Cache-Control", "no-store")
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $ctx.Response.OutputStream.Close()
    } catch {
        try { $ctx.Response.Abort() } catch {}
    }
}

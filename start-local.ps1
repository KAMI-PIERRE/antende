$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

$envPath = Join-Path $projectRoot ".env"
$lines = @(Get-Content $envPath)
$config = @{}
foreach ($line in $lines) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
    $config[$matches[1]] = $matches[2]
  }
}

$supabaseKey = $config["SUPABASE_KEY"]
$serviceRoleKey = $config["SUPABASE_SERVICE_ROLE_KEY"]
if ((-not $supabaseKey -or $supabaseKey -match "^replace-with-") -and
    (-not $serviceRoleKey -or $serviceRoleKey -match "^replace-with-")) {
  Write-Host "Enter the Supabase publishable key (sb_publishable_...) for local testing."
  Write-Host "With RLS disabled, use test data only; the database may be publicly accessible."
  $secureKey = Read-Host "Supabase publishable key" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $supabaseKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  if (-not $supabaseKey -or $supabaseKey.Length -lt 20) {
    throw "A Supabase API key is required. No key was saved."
  }
  $config["SUPABASE_KEY"] = $supabaseKey
}

function New-LocalKey {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }
  return ([BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant())
}

if (-not $config["ADMIN_API_KEY"] -or $config["ADMIN_API_KEY"] -match "^replace-with-") {
  $config["ADMIN_API_KEY"] = New-LocalKey
}
if (-not $config["DEVICE_API_KEY"] -or $config["DEVICE_API_KEY"] -match "^replace-with-") {
  $config["DEVICE_API_KEY"] = New-LocalKey
}
$config["SUPABASE_URL"] = "https://ixihlqpxmgyqrlwdcblf.supabase.co"
if (-not $config["PORT"]) { $config["PORT"] = "3000" }
if (-not $config["ATTENDANCE_TIME_ZONE"]) { $config["ATTENDANCE_TIME_ZONE"] = "UTC" }
if (-not $config["DEVICE_ID"]) { $config["DEVICE_ID"] = "esp32-01" }

$orderedKeys = @(
  "PORT",
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_API_KEY",
  "DEVICE_API_KEY",
  "ATTENDANCE_TIME_ZONE",
  "DEVICE_ID"
)
$envContent = foreach ($key in $orderedKeys) {
  "$key=$($config[$key])"
}
Set-Content -Path $envPath -Value $envContent -Encoding ASCII

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing project dependencies..."
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
}

Write-Host ""
Write-Host "antende is ready. Sign in at http://localhost:$($config['PORT'])"
Write-Host "Administrator key (save it privately): $($config['ADMIN_API_KEY'])"
Write-Host "Device key is saved in .env; use it for the ESP32 setup later."
Write-Host "Keep this terminal open while testing. Press Ctrl+C to stop the server."
Write-Host ""
& npm start
if ($LASTEXITCODE -ne 0) { throw "antende stopped with an error." }

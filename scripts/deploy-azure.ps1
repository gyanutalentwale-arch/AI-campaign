param(
  [string]$SubscriptionId = "",
  [Parameter(Mandatory = $true)][string]$ResourceGroup,
  [string]$Location = "centralindia",
  [Parameter(Mandatory = $true)][string]$AppName,
  [string]$PlanName = "",
  [string]$AcrName = "",
  [string]$ImageName = "wp-bot",
  [string]$ImageTag = "",
  [string]$Sku = "P1v3",
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

function Resolve-AzCommand {
  $azCmd = Get-Command az -ErrorAction SilentlyContinue
  if ($azCmd) {
    return $azCmd.Source
  }

  $fallback = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
  if (Test-Path $fallback) {
    return $fallback
  }

  throw "Azure CLI not found. Install it first: winget install --id Microsoft.AzureCLI -e"
}

function Invoke-Az {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args
  )

  & $script:AzExe @Args
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI command failed: az $($Args -join ' ')"
  }
}

function Invoke-AzCapture {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args
  )

  $output = & $script:AzExe @Args
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI command failed: az $($Args -join ' ')"
  }
  return $output
}

function Test-AzLogin {
  try {
    & $script:AzExe account show --output none *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Get-SafeName {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [int]$MaxLength = 30
  )

  $tmp = $Value.ToLower() -replace "[^a-z0-9-]", ""
  $tmp = $tmp.Trim("-")
  if ([string]::IsNullOrWhiteSpace($tmp)) {
    throw "Invalid name after normalization: $Value"
  }
  if ($tmp.Length -gt $MaxLength) {
    return $tmp.Substring(0, $MaxLength).Trim("-")
  }
  return $tmp
}

function Read-EnvFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $map = @{}
  if (-not (Test-Path $Path)) {
    return $map
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ([string]::IsNullOrWhiteSpace($line)) { return }
    if ($line.StartsWith("#")) { return }
    if (-not $line.Contains("=")) { return }

    $parts = $line.Split("=", 2)
    $k = $parts[0].Trim()
    $v = $parts[1]

    if ($k) {
      $map[$k] = $v.Trim()
    }
  }

  return $map
}

function Is-PlaceholderValue {
  param([string]$Value)

  $v = ""
  if ($null -ne $Value) {
    $v = $Value.Trim().ToLower()
  }
  if ([string]::IsNullOrWhiteSpace($v)) { return $true }
  if ($v -like "your_*") { return $true }
  if ($v -like "*yourdomain*") { return $true }
  if ($v -like "*example*") { return $true }
  return $false
}

function Ensure-ResourceGroup {
  Write-Host "Ensuring resource group '$ResourceGroup' in '$Location'..."
  Invoke-Az @("group", "create", "--name", $ResourceGroup, "--location", $Location, "--output", "none")
}

function Ensure-Acr {
  param([string]$Name)

  Write-Host "Ensuring ACR '$Name'..."
  $exists = $false
  try {
    Invoke-AzCapture @("acr", "show", "--name", $Name, "--resource-group", $ResourceGroup, "--query", "name", "-o", "tsv") | Out-Null
    $exists = $true
  } catch {
    $exists = $false
  }

  if (-not $exists) {
    Invoke-Az @("acr", "create", "--name", $Name, "--resource-group", $ResourceGroup, "--sku", "Basic", "--admin-enabled", "true", "--output", "none")
  } else {
    Invoke-Az @("acr", "update", "--name", $Name, "--resource-group", $ResourceGroup, "--admin-enabled", "true", "--output", "none")
  }
}

function Ensure-Plan {
  param([string]$Name)

  Write-Host "Ensuring App Service plan '$Name' ($Sku)..."
  $exists = $false
  try {
    Invoke-AzCapture @("appservice", "plan", "show", "--name", $Name, "--resource-group", $ResourceGroup, "--query", "name", "-o", "tsv") | Out-Null
    $exists = $true
  } catch {
    $exists = $false
  }

  if (-not $exists) {
    Invoke-Az @("appservice", "plan", "create", "--name", $Name, "--resource-group", $ResourceGroup, "--is-linux", "--sku", $Sku, "--output", "none")
  } else {
    Invoke-Az @("appservice", "plan", "update", "--name", $Name, "--resource-group", $ResourceGroup, "--sku", $Sku, "--output", "none")
  }
}

function Ensure-WebApp {
  param(
    [string]$Name,
    [string]$Plan
  )

  Write-Host "Ensuring Web App '$Name'..."
  $exists = $false
  try {
    Invoke-AzCapture @("webapp", "show", "--name", $Name, "--resource-group", $ResourceGroup, "--query", "name", "-o", "tsv") | Out-Null
    $exists = $true
  } catch {
    $exists = $false
  }

  if (-not $exists) {
    Invoke-Az @("webapp", "create", "--name", $Name, "--resource-group", $ResourceGroup, "--plan", $Plan, "--runtime", "NODE|20-lts", "--output", "none")
  }
}

$script:AzExe = Resolve-AzCommand

if (-not (Test-AzLogin)) {
  throw "Azure login required. Run: az login --use-device-code"
}

if ($SubscriptionId) {
  Write-Host "Setting subscription: $SubscriptionId"
  Invoke-Az @("account", "set", "--subscription", $SubscriptionId)
}

$normalizedApp = Get-SafeName -Value $AppName -MaxLength 40
if ($AppName -ne $normalizedApp) {
  Write-Host "Normalizing app name from '$AppName' to '$normalizedApp' for Azure compatibility."
  $AppName = $normalizedApp
}

if ([string]::IsNullOrWhiteSpace($PlanName)) {
  $PlanName = Get-SafeName -Value "plan-$normalizedApp" -MaxLength 40
}

if ([string]::IsNullOrWhiteSpace($AcrName)) {
  $AcrName = ("acr" + ($normalizedApp -replace "-", ""))
}
$AcrName = Get-SafeName -Value $AcrName -MaxLength 50
$AcrName = $AcrName -replace "-", ""

if ([string]::IsNullOrWhiteSpace($ImageTag)) {
  $ImageTag = Get-Date -Format "yyyyMMddHHmmss"
}

Write-Host "----- Deployment Plan -----"
Write-Host "Resource Group : $ResourceGroup"
Write-Host "Location       : $Location"
Write-Host "Plan           : $PlanName ($Sku)"
Write-Host "Web App        : $AppName"
Write-Host "ACR            : $AcrName"
Write-Host "Image          : ${ImageName}:$ImageTag"
Write-Host "Env File       : $EnvFile"
Write-Host "---------------------------"

Ensure-ResourceGroup
Ensure-Acr -Name $AcrName
Ensure-Plan -Name $PlanName
Ensure-WebApp -Name $AppName -Plan $PlanName

Write-Host "Building container in ACR..."
Invoke-Az @("acr", "build", "--registry", $AcrName, "--image", "$ImageName`:$ImageTag", ".")

$acrUser = (Invoke-AzCapture @("acr", "credential", "show", "--name", $AcrName, "--query", "username", "-o", "tsv")).Trim()
$acrPass = (Invoke-AzCapture @("acr", "credential", "show", "--name", $AcrName, "--query", "passwords[0].value", "-o", "tsv")).Trim()
$imageRef = "${AcrName}.azurecr.io/${ImageName}:$ImageTag"

Write-Host "Configuring container image..."
Invoke-Az @(
  "webapp", "config", "container", "set",
  "--name", $AppName,
  "--resource-group", $ResourceGroup,
  "--container-image-name", $imageRef,
  "--container-registry-url", "https://$AcrName.azurecr.io",
  "--container-registry-user", $acrUser,
  "--container-registry-password", $acrPass,
  "--enable-app-service-storage", "true"
)

$envMap = Read-EnvFile -Path $EnvFile
$settings = @(
  "WEBSITES_PORT=3000",
  "WEBSITES_ENABLE_APP_SERVICE_STORAGE=true",
  "APP_DATA_DIR=/home/site/data",
  "NODE_ENV=production"
)

$forwardKeys = @(
  "GEMINI_API_KEY",
  "FALLBACK_MODEL",
  "WA_CAMPAIGN_AI_ENABLED",
  "WA_CAMPAIGN_AI_MODEL",
  "WA_AI_MIN_CHARS",
  "WA_AI_MAX_CHARS",
  "WA_AI_MAX_PARAGRAPHS",
  "WA_AI_BLOCKED_TERMS",
  "EMAIL_1_USER",
  "EMAIL_1_PASSWORD",
  "EMAIL_1_NAME",
  "EMAIL_2_USER",
  "EMAIL_2_PASSWORD",
  "EMAIL_2_NAME",
  "EMAIL_3_USER",
  "EMAIL_3_PASSWORD",
  "EMAIL_3_NAME",
  "EMAIL_DAILY_LIMIT",
  "EMAIL_PROVIDER_DAILY_LIMIT",
  "TALENTWALE_ADMIN_EMAIL",
  "TALENTWALE_ADMIN_PASSWORD",
  "TALENTWALE_ADMIN_ROLE"
)

$appliedKeys = @()
foreach ($key in $forwardKeys) {
  if (-not $envMap.ContainsKey($key)) { continue }
  $value = $envMap[$key]
  if (Is-PlaceholderValue $value) { continue }
  $settings += "$key=$value"
  $appliedKeys += $key
}

Write-Host "Applying app settings..."
$appSettingsArgs = @("webapp", "config", "appsettings", "set", "--name", $AppName, "--resource-group", $ResourceGroup, "--settings") + $settings
Invoke-Az -Args $appSettingsArgs

Write-Host "Enabling WebSockets and Always On..."
Invoke-Az @("webapp", "config", "set", "--name", $AppName, "--resource-group", $ResourceGroup, "--web-sockets-enabled", "true", "--always-on", "true")

Write-Host "Restarting app..."
Invoke-Az @("webapp", "restart", "--name", $AppName, "--resource-group", $ResourceGroup)

$hostName = (Invoke-AzCapture @("webapp", "show", "--name", $AppName, "--resource-group", $ResourceGroup, "--query", "defaultHostName", "-o", "tsv")).Trim()

Write-Host ""
Write-Host "Deployment complete."
Write-Host "URL: https://$hostName"
Write-Host "Image: $imageRef"
Write-Host "Applied env keys: $($appliedKeys -join ', ')"
Write-Host ""
Write-Host "Tip: Keep scale-out instance count at 1 for WhatsApp session stability."

$ErrorActionPreference = "Stop"

$RG = "wp-bot-rg"
$LOCATION = "eastus"
$ACR_NAME = "wpbotacr71191"
$PLAN_NAME = "wp-bot-plan"
$APP_NAME = "wpbotapp71191"

Write-Host "================== AZURE DEPLOYMENT CONTINUATION =================="

Write-Host "1. Creating App Service Plan (B1 Linux)..."
az appservice plan create --name $PLAN_NAME --resource-group $RG --is-linux --sku B1 -o none

Write-Host "2. Getting ACR Credentials..."
$ACR_USERNAME = az acr credential show --name $ACR_NAME --query username -o tsv
$ACR_PASSWORD = az acr credential show --name $ACR_NAME --query passwords[0].value -o tsv
$ACR_LOGIN_SERVER = az acr show --name $ACR_NAME --query loginServer -o tsv

Write-Host "3. Creating Web App: $APP_NAME"
# Note: we use a placeholder image for now because the actual image isn't built yet
az webapp create --resource-group $RG --plan $PLAN_NAME --name $APP_NAME --deployment-container-image-name "mcr.microsoft.com/appsvc/staticsite:latest" -o none

Write-Host "4. Configuring Web App Docker settings..."
az webapp config container set --name $APP_NAME --resource-group $RG --docker-custom-image-name "$($ACR_LOGIN_SERVER)/wpbot:v1" --docker-registry-server-url "https://$ACR_LOGIN_SERVER" --docker-registry-server-user $ACR_USERNAME --docker-registry-server-password $ACR_PASSWORD -o none

Write-Host "5. Applying App Settings from .env..."
$envSettings = @()
foreach ($line in Get-Content .env) {
    if (![string]::IsNullOrWhiteSpace($line) -and !$line.StartsWith('#')) {
        $envSettings += $line
    }
}
$envSettings += "WEBSITES_PORT=3000"
$envSettings += "WEBSITES_ENABLE_APP_SERVICE_STORAGE=false"
# Space separate variables for Azure CLI appsettings
$settingsString = $envSettings -join " "
Invoke-Expression "az webapp config appsettings set --resource-group $RG --name $APP_NAME --settings $settingsString -o none"

Write-Host "================== AZURE DEPLOYMENT INFRASTRUCTURE READY =================="
Write-Host "App URL: https://$APP_NAME.azurewebsites.net"
Write-Host "ACR Login Server: $ACR_LOGIN_SERVER"
Write-Host "ACR Username: $ACR_USERNAME"
Write-Host "ACR Password: $ACR_PASSWORD"

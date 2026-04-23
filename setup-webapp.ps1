$ErrorActionPreference = "Stop"

$RG = "wp-bot-rg"
$LOCATION = "centralindia"
$ACR_NAME = "wpbottestacr202604"
$PLAN_NAME = "test-plan"
$APP_NAME = "wp-bot-web-app-$(Get-Random -Minimum 100 -Maximum 999)"

Write-Host "Creating Web App: $APP_NAME"
az webapp create --resource-group $RG --plan $PLAN_NAME --name $APP_NAME --deployment-container-image-name "mcr.microsoft.com/appsvc/staticsite:latest" -o none

Write-Host "Getting ACR Credentials..."
$ACR_USERNAME = az acr credential show --name $ACR_NAME --query username -o tsv
$ACR_PASSWORD = az acr credential show --name $ACR_NAME --query passwords[0].value -o tsv
$ACR_LOGIN_SERVER = az acr show --name $ACR_NAME --query loginServer -o tsv

Write-Host "Configuring Web App Docker settings..."
az webapp config container set --name $APP_NAME --resource-group $RG --docker-custom-image-name "$($ACR_LOGIN_SERVER)/wpbot:latest" --docker-registry-server-url "https://$ACR_LOGIN_SERVER" --docker-registry-server-user $ACR_USERNAME --docker-registry-server-password $ACR_PASSWORD -o none

Write-Host "Applying App Settings from .env..."
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
# Write these values to a file for easy reading
$OutputJson = @{
    AppName = $APP_NAME
    AppUrl = "https://$APP_NAME.azurewebsites.net"
    AcrLoginServer = $ACR_LOGIN_SERVER
    AcrUsername = $ACR_USERNAME
    AcrPassword = $ACR_PASSWORD
}
$OutputJson | ConvertTo-Json | Out-File "azure-deployment-info.json"

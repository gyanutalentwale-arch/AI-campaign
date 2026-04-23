$ErrorActionPreference = "Stop"

$RG = "wp-bot-rg"
$LOCATION = "eastus"
$randObj = Get-Random -Minimum 10000 -Maximum 99999
$ACR_NAME = "wpbotacr$randObj"
$PLAN_NAME = "wp-bot-plan"
$APP_NAME = "wp-bot-app-$randObj"

Write-Host "================== AZURE DEPLOYMENT STARTED =================="
Write-Host "1. Creating Resource Group: $RG in $LOCATION"
az group create --name $RG --location $LOCATION -o none

Write-Host "2. Creating Azure Container Registry: $ACR_NAME"
az acr create --resource-group $RG --name $ACR_NAME --sku Basic --admin-enabled true -o none

Write-Host "3. Building Docker Image in ACR... (This takes a few minutes)"
az acr build --registry $ACR_NAME --image wpbot:v1 . -o none

Write-Host "4. Creating App Service Plan (B1 Linux)..."
az appservice plan create --name $PLAN_NAME --resource-group $RG --is-linux --sku B1 -o none

Write-Host "5. Getting ACR Credentials..."
$ACR_USERNAME = az acr credential show --name $ACR_NAME --query username -o tsv
$ACR_PASSWORD = az acr credential show --name $ACR_NAME --query passwords[0].value -o tsv
$ACR_LOGIN_SERVER = az acr show --name $ACR_NAME --query loginServer -o tsv

Write-Host "6. Creating Web App: $APP_NAME"
az webapp create --resource-group $RG --plan $PLAN_NAME --name $APP_NAME --deployment-container-image-name "$($ACR_LOGIN_SERVER)/wpbot:v1" -o none

Write-Host "7. Configuring Web App Docker settings..."
az webapp config container set --name $APP_NAME --resource-group $RG --docker-custom-image-name "$($ACR_LOGIN_SERVER)/wpbot:v1" --docker-registry-server-url "https://$ACR_LOGIN_SERVER" --docker-registry-server-user $ACR_USERNAME --docker-registry-server-password $ACR_PASSWORD -o none

Write-Host "8. Applying App Settings from .env..."
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

Write-Host "================== AZURE DEPLOYMENT COMPLETED =================="
Write-Host "App URL: https://$APP_NAME.azurewebsites.net"

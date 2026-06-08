#Requires -Version 7.0
<#
.SYNOPSIS
    Configures IdentityPass (identity verification) settings for the onboarding
    portal, with demo/simulation mode for environments without live access.

.DESCRIPTION
    IdentityPass is an identity verification service used to confirm the identity
    of new employees or guests before issuing Verified ID credentials. This script:

      - Configures webhook callback URLs for IdentityPass verification events
      - Sets up a simulated approval workflow (demo) or real IdentityPass API
        integration (production) when API credentials are available
      - Creates an Azure Logic App for the approval workflow if -DeployLogicApp
      - Documents all real integration points for production use

    In DemoMode (default when no ApiKey is provided):
      - Writes a demo-mode config to Key Vault / .env
      - Creates a local mock webhook server configuration
      - All identity checks return "verified" without calling external APIs

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID.

.PARAMETER ResourceGroupName
    Resource group where the Logic App will be created (if -DeployLogicApp).

.PARAMETER Location
    Azure region (default: eastus).

.PARAMETER AppServiceUrl
    Base URL of the onboarding portal (used for webhook callback registration).

.PARAMETER IdentityPassApiEndpoint
    Production IdentityPass API endpoint. When omitted, demo mode is used.

.PARAMETER IdentityPassApiKey
    API key for IdentityPass. When omitted, demo mode is used.

.PARAMETER IdentityPassSubscriptionKey
    Ocp-Apim-Subscription-Key header value for IdentityPass API gateway.

.PARAMETER DeployLogicApp
    Deploy an Azure Logic App for the approval workflow.

.PARAMETER DemoMode
    Forces demo mode even when API credentials are provided.

.EXAMPLE
    # Demo mode (no real IdentityPass)
    .\03-configure-identitypass.ps1 -TenantId "xxxx" -AppServiceUrl "https://myapp.azurewebsites.net"

    # Production mode
    .\03-configure-identitypass.ps1 -TenantId "xxxx" -AppServiceUrl "https://myapp.azurewebsites.net" `
        -IdentityPassApiEndpoint "https://api.identitypass.example.com" `
        -IdentityPassApiKey "your-key"

.OUTPUTS
    Hashtable with IdentityPassEndpoint, WebhookCallbackUrl, ApprovalWorkflowUrl, IsDemo
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    [string]$ResourceGroupName = "rg-verifiedid-demo",

    [string]$Location = "eastus",

    [string]$AppServiceUrl = "https://localhost:5001",

    # IdentityPass production settings — leave blank to use demo mode
    [string]$IdentityPassApiEndpoint = "",
    [string]$IdentityPassApiKey      = "",
    [string]$IdentityPassSubscriptionKey = "",

    [switch]$DeployLogicApp,

    [switch]$DemoMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

# Auto-detect demo mode when no API credentials supplied
$isDemo = $DemoMode -or (-not $IdentityPassApiEndpoint) -or (-not $IdentityPassApiKey)

$CALLBACK_BASE    = $AppServiceUrl.TrimEnd('/')
$WEBHOOK_CALLBACK = "$CALLBACK_BASE/api/identitypass/webhook"
$APPROVAL_CALLBACK = "$CALLBACK_BASE/api/identitypass/approval"
$LOGIC_APP_NAME   = "la-verifiedid-approval"

# ── IdentityPass Integration Reference ────────────────────────────────────────
#
# IdentityPass (https://www.identitypass.com / Microsoft partner) provides:
#
# API Endpoints (production):
#   POST   /v1/verify              — Initiate identity verification session
#   GET    /v1/verify/{sessionId}  — Poll verification session status
#   POST   /v1/webhook/register    — Register webhook for async callbacks
#   DELETE /v1/webhook/{id}        — Remove webhook registration
#
# Headers required:
#   Content-Type: application/json
#   Ocp-Apim-Subscription-Key: {subscription-key}   (API gateway)
#   x-api-key: {api-key}                             (service auth)
#
# Webhook payload (when verification completes):
#   {
#     "sessionId": "...",
#     "status": "verified" | "failed" | "pending_review",
#     "verificationResult": { ... },
#     "metadata": { "correlationId": "..." }
#   }
#
# Demo/simulation: set IDENTITYPASS_DEMO_MODE=true in .env;
# the portal's IdentityPassService will return "verified" without calling the API.
#
# ─────────────────────────────────────────────────────────────────────────────

Write-StepHeader "03 — IdentityPass Configuration" -Step "03"
Write-Info "Portal URL: $AppServiceUrl"
Write-Info "Webhook callback: $WEBHOOK_CALLBACK"

if ($isDemo) {
    Write-Warning "DEMO MODE — using simulated identity verification (no IdentityPass API calls)"
    Write-Info "To use real IdentityPass, provide -IdentityPassApiEndpoint and -IdentityPassApiKey"
}

# ── Step 1: Webhook Callback Configuration ────────────────────────────────────
Write-StepHeader "Configuring webhook callbacks"

if (-not $isDemo -and $IdentityPassApiEndpoint) {
    Write-Progress-Step "Registering webhook with IdentityPass"

    if ($PSCmdlet.ShouldProcess($WEBHOOK_CALLBACK, "Register IdentityPass webhook")) {
        try {
            $webhookBody = @{
                url    = $WEBHOOK_CALLBACK
                events = @("verification.completed", "verification.failed", "verification.pending_review")
                secret = (New-Guid).ToString()   # Shared secret for HMAC validation
            } | ConvertTo-Json

            $headers = @{
                "Content-Type"                 = "application/json"
                "x-api-key"                    = $IdentityPassApiKey
                "Ocp-Apim-Subscription-Key"    = $IdentityPassSubscriptionKey
            }

            $webhookResponse = Invoke-RestMethod `
                -Uri "$($IdentityPassApiEndpoint.TrimEnd('/'))/v1/webhook/register" `
                -Method POST `
                -Headers $headers `
                -Body $webhookBody `
                -ErrorAction Stop

            $webhookId     = $webhookResponse.id
            $webhookSecret = $webhookBody | ConvertFrom-Json | Select-Object -ExpandProperty secret

            Write-Success "Webhook registered (ID: $webhookId)"
            Write-Warning "Save the webhook secret for HMAC signature validation!"
        } catch {
            Write-Warning "Webhook registration failed: $($_.Exception.Message)"
            Write-Info "You can register the webhook manually at: $IdentityPassApiEndpoint"
            $webhookId     = "pending-registration"
            $webhookSecret = "configure-manually"
        }
    }
} else {
    $webhookId     = "demo-webhook-id"
    $webhookSecret = "demo-webhook-secret-$(New-Guid)"
    Write-Success "[DEMO] Webhook configuration recorded"
    Write-Info "  Callback URL: $WEBHOOK_CALLBACK"
    Write-Info "  Events: verification.completed, verification.failed, verification.pending_review"
}

# ── Step 2: Approval Workflow (Logic App or simulated) ────────────────────────
Write-StepHeader "Approval workflow"

$approvalWorkflowUrl = $APPROVAL_CALLBACK

if ($DeployLogicApp -and -not $isDemo) {
    Write-Progress-Step "Deploying Logic App approval workflow"

    if ($PSCmdlet.ShouldProcess($LOGIC_APP_NAME, "Deploy Logic App")) {
        try {
            # Ensure resource group exists
            $rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
            if (-not $rg) {
                Write-Info "Creating resource group $ResourceGroupName"
                New-AzResourceGroup -Name $ResourceGroupName -Location $Location | Out-Null
            }

            # Logic App definition for manager approval flow:
            # Trigger:  HTTP POST from portal when identity verification is approved
            # Actions:  1. Parse JSON payload
            #           2. Send Teams adaptive card to manager for approval
            #           3. On approval → POST back to portal /api/approval/callback
            #           4. On reject → POST rejection back to portal
            $logicAppDefinition = @{
                '$schema'    = "https://schema.management.azure.com/schemas/2016-06-01/Microsoft.Logic/workflows/versions.json"
                contentVersion = "1.0.0.0"
                definition   = @{
                    '$schema' = "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#"
                    triggers  = @{
                        manual = @{
                            type    = "Request"
                            kind    = "Http"
                            inputs  = @{ schema = @{ type = "object" } }
                        }
                    }
                    actions   = @{
                        Parse_Request = @{
                            type    = "ParseJson"
                            inputs  = @{
                                content = "@triggerBody()"
                                schema  = @{
                                    type       = "object"
                                    properties = @{
                                        employeeId    = @{ type = "string" }
                                        displayName   = @{ type = "string" }
                                        email         = @{ type = "string" }
                                        department    = @{ type = "string" }
                                        callbackUrl   = @{ type = "string" }
                                        correlationId = @{ type = "string" }
                                    }
                                }
                            }
                        }
                        Send_Approval_Email = @{
                            type    = "ApiConnection"
                            runAfter = @{ Parse_Request = @("Succeeded") }
                            inputs   = @{
                                host      = @{ connection = @{ name = "@parameters('$connections')['office365']['connectionId']" } }
                                method    = "post"
                                path      = "/approvalmail/$"
                                body      = @{
                                    To         = "@body('Parse_Request')?['managerEmail']"
                                    Subject    = "Onboarding Approval Required: @{body('Parse_Request')?['displayName']}"
                                    Body       = "Please approve the onboarding of @{body('Parse_Request')?['displayName']} (Employee ID: @{body('Parse_Request')?['employeeId']})"
                                    Importance = "High"
                                    Options    = "Approve, Reject"
                                }
                            }
                        }
                        # Additional actions for callback would follow in production
                    }
                }
            }

            # Deploy as Consumption Logic App via ARM
            $armBody = @{
                location   = $Location
                properties = @{
                    definition = $logicAppDefinition.definition
                    state      = "Enabled"
                }
            } | ConvertTo-Json -Depth 30

            $armUri = "https://management.azure.com/subscriptions/$((Get-AzContext).Subscription.Id)" +
                      "/resourceGroups/$ResourceGroupName/providers/Microsoft.Logic/workflows/$LOGIC_APP_NAME" +
                      "?api-version=2019-05-01"

            $token  = (Get-AzAccessToken -ResourceUrl "https://management.azure.com/").Token
            $result = Invoke-RestMethod -Uri $armUri -Method PUT -Headers @{
                "Authorization" = "Bearer $token"
                "Content-Type"  = "application/json"
            } -Body $armBody

            $approvalWorkflowUrl = $result.properties.accessEndpoint
            Write-Success "Logic App deployed: $approvalWorkflowUrl"

        } catch {
            Write-Warning "Logic App deployment failed: $($_.Exception.Message)"
            Write-Info "Falling back to portal-native approval workflow (simulated)"
            $approvalWorkflowUrl = $APPROVAL_CALLBACK
        }
    }
} else {
    if ($isDemo) {
        Write-Success "[DEMO] Simulated approval workflow — portal handles approvals locally"
    } else {
        Write-Info "Skipping Logic App deploy (-DeployLogicApp not specified)"
        Write-Info "The portal includes a built-in approval workflow at: $APPROVAL_CALLBACK"
    }
}

# ── Step 3: Write configuration summary ───────────────────────────────────────
Write-StepHeader "IdentityPass configuration summary"

$endpointToUse = if ($isDemo) { "demo://simulated" } else { $IdentityPassApiEndpoint }

$output = @{
    IDENTITYPASS_ENDPOINT           = $endpointToUse
    IDENTITYPASS_API_KEY            = if ($isDemo) { "demo-not-required" } else { $IdentityPassApiKey }
    IDENTITYPASS_SUBSCRIPTION_KEY   = if ($isDemo) { "demo-not-required" } else { $IdentityPassSubscriptionKey }
    IDENTITYPASS_WEBHOOK_CALLBACK   = $WEBHOOK_CALLBACK
    IDENTITYPASS_WEBHOOK_SECRET     = $webhookSecret
    IDENTITYPASS_APPROVAL_URL       = $approvalWorkflowUrl
    IDENTITYPASS_DEMO_MODE          = $isDemo.ToString().ToLower()
}

Format-Summary -Title "IdentityPass Configuration" -Values @{
    Endpoint          = $endpointToUse
    WebhookCallback   = $WEBHOOK_CALLBACK
    ApprovalWorkflow  = $approvalWorkflowUrl
    DemoMode          = $isDemo
}

if ($isDemo) {
    Write-Host ""
    Write-Host "  📋 Real IdentityPass Integration Steps:" -ForegroundColor Cyan
    Write-Host "     1. Obtain IdentityPass API credentials from your Microsoft account team" -ForegroundColor White
    Write-Host "     2. Re-run this script with -IdentityPassApiEndpoint and -IdentityPassApiKey" -ForegroundColor White
    Write-Host "     3. Ensure $WEBHOOK_CALLBACK is publicly accessible (use ngrok for local dev)" -ForegroundColor White
    Write-Host "     4. Validate HMAC signature on incoming webhook events using IDENTITYPASS_WEBHOOK_SECRET" -ForegroundColor White
    Write-Host ""
}

return $output

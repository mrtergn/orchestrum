param(
  [Parameter(Mandatory = $true)]
  [string]$Package
)

$ErrorActionPreference = "Stop"

try {
  if (-not (Test-Path -LiteralPath $Package)) {
    throw "Update package path does not exist: $Package"
  }

  $resolved = Resolve-Path -LiteralPath $Package
  Write-Host "Installing Orchestrum update from $resolved"
  orchestrum update install "$resolved"
  Write-Host "Update install completed successfully."
}
catch {
  Write-Error "Update install failed: $($_.Exception.Message)"
  exit 1
}

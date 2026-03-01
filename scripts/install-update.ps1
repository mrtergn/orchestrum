param(
  [Parameter(Mandatory = $true)]
  [string]$Package
)

Write-Host "Installing Orchestrum update from $Package"
orchestrum update install $Package

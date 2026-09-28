$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptDir 'install-remote.mjs') @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

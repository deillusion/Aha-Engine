$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& node --env-file-if-exists=.env server.mjs

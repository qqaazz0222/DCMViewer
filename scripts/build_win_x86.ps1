#!/usr/bin/env pwsh

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AppName = "DCMViewer"
$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$Targets = @("nsis", "zip")

function Write-Step {
	param([string]$Message)
	Write-Host ""
	Write-Host "[$AppName] $Message"
}

function Assert-Command {
	param([string]$Name)

	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		throw "Required command not found: $Name"
	}

	& $Name --version *> $null

	if ($LASTEXITCODE -ne 0) {
		throw "Required command is installed but cannot run: $Name"
	}
}

function Invoke-NativeCommand {
	param(
		[string]$Label,
		[string]$FilePath,
		[string[]]$Arguments
	)

	Write-Step $Label
	& $FilePath @Arguments

	if ($LASTEXITCODE -ne 0) {
		throw "$Label failed with exit code $LASTEXITCODE"
	}
}

Set-Location $RootDir

Assert-Command node
Assert-Command npm
Assert-Command npx

$IsWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
	[System.Runtime.InteropServices.OSPlatform]::Windows
)

if (-not $IsWindows -and -not (Get-Command wine -ErrorAction SilentlyContinue)) {
	Write-Step "Warning: Windows NSIS cross-builds usually require Wine on non-Windows hosts."
}

if (-not (Test-Path "node_modules" -PathType Container)) {
	Invoke-NativeCommand "Installing dependencies with npm ci" "npm" @("ci")
}

if (-not $env:CSC_IDENTITY_AUTO_DISCOVERY) {
	$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
}

Invoke-NativeCommand "Building renderer and Electron main process" "npm" @("run", "build")
Invoke-NativeCommand "Packaging Windows x86 desktop app ($($Targets -join ', '))" "npx" @("electron-builder", "--win", "nsis", "zip", "--ia32")

Write-Step "Done. Packaged files are in: $RootDir/release"

<#
.SYNOPSIS
    Env & PATH Doctor — Windows Unified Build & Verification Script (PowerShell)
.DESCRIPTION
    Builds and verifies the frontend (React + Vite), backend (Rust + Cargo tests),
    and Tauri desktop installer bundles (.msi / .exe).
.PARAMETER Target
    Task target to execute:
    - all      : Verify dependencies + build frontend + run Rust tests + build Tauri release bundles (default)
    - check    : Build frontend (TypeScript/Vite) + run Rust unit tests and cargo check
    - frontend : Build frontend production bundle (dist/) only
    - test     : Run Rust backend unit tests (cargo test) only
    - bundle   : Build Tauri desktop installer packages (.msi, .exe)
    - clean    : Clean dist/ and src-tauri/target build artifacts
.PARAMETER DebugBuild
    Build Tauri desktop bundle with debug symbols enabled.
.EXAMPLE
    .\scripts\build.ps1
    .\scripts\build.ps1 -Target check
    .\scripts\build.ps1 -Target bundle -DebugBuild
#>

param(
    [ValidateSet("all", "check", "frontend", "test", "bundle", "clean")]
    [string]$Target = "all",

    [switch]$DebugBuild
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Write-Step([string]$Message) {
    Write-Host "`n==========================================================" -ForegroundColor Cyan
    Write-Host "[Env & PATH Doctor] $Message" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Cyan
}

function Assert-Tool([string]$CommandName, [string]$InstallHint) {
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        Write-Error "Required command '$CommandName' was not found. $InstallHint"
        exit 1
    }
}

Write-Step "Checking required development toolchain versions"
Assert-Tool "node" "Please install Node.js (v20+): https://nodejs.org"
Assert-Tool "npm" "Please ensure npm is installed."
Assert-Tool "cargo" "Please install the Rust toolchain (rustup): https://rustup.rs"

Write-Host "• Node.js : $(node -v)"
Write-Host "• npm     : v$(npm -v)"
Write-Host "• rustc   : $(rustc -V)"
Write-Host "• cargo   : $(cargo -V)"

if ($Target -eq "clean") {
    Write-Step "Cleaning build caches and artifacts (clean)"
    if (Test-Path "$ProjectRoot\dist") {
        Remove-Item -Recurse -Force "$ProjectRoot\dist"
        Write-Host "Removed dist/"
    }
    Push-Location "$ProjectRoot\src-tauri"
    cargo clean
    Pop-Location
    Write-Host "Cleaned src-tauri/target"
    exit 0
}

if (-not (Test-Path "$ProjectRoot\node_modules")) {
    Write-Step "Installing frontend dependencies (npm install)"
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Target -in @("all", "check", "frontend")) {
    Write-Step "Building frontend TypeScript & Vite production bundle"
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Frontend build failed."
        exit $LASTEXITCODE
    }
    Write-Host "Frontend build succeeded (dist/)" -ForegroundColor Green
}

if ($Target -in @("all", "check", "test")) {
    Write-Step "Running Rust backend unit tests and compilation checks"
    Push-Location "$ProjectRoot\src-tauri"
    try {
        cargo test --lib
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Rust unit tests failed."
            exit $LASTEXITCODE
        }
        if ($Target -eq "check") {
            cargo check --bins
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Rust binary target check failed."
                exit $LASTEXITCODE
            }
        }
    }
    finally {
        Pop-Location
    }
    Write-Host "Rust core engine tests and checks passed" -ForegroundColor Green
}

if ($Target -in @("all", "bundle")) {
    Write-Step "Packaging Tauri v2 desktop application bundles (.msi / .exe)"
    if ($DebugBuild) {
        npx tauri build --debug
    }
    else {
        npx tauri build
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Tauri bundle build failed."
        exit $LASTEXITCODE
    }

    $BundleDir = "$ProjectRoot\src-tauri\target\release\bundle"
    if ($DebugBuild) {
        $BundleDir = "$ProjectRoot\src-tauri\target\debug\bundle"
    }
    Write-Host "`nBuild completed successfully!" -ForegroundColor Green
    Write-Host "Artifacts directory: $BundleDir" -ForegroundColor Yellow
}

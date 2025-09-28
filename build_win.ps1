# Windows app build script with environment setup
$ErrorActionPreference = "Stop"

Write-Host "Starting Windows app build with environment setup..." -ForegroundColor Green

# Function to check if conda is available
function Test-CondaAvailable {
    $conda = Get-Command "conda" -ErrorAction SilentlyContinue
    return $null -ne $conda
}

# Function to check if python is available
function Test-PythonAvailable {
    $python = Get-Command "python" -ErrorAction SilentlyContinue
    return $null -ne $python
}

# Environment setup
$envName = "dcmviewer-env"
$usesConda = $false

if (Test-CondaAvailable) {
    Write-Host "Conda detected. Creating conda environment..." -ForegroundColor Cyan
    $usesConda = $true
    
    # Create conda environment with Python 3.9
    conda create -n $envName python=3.9 -y
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to create conda environment" -ForegroundColor Red
        exit 1
    }
    
    # Activate conda environment
    conda activate $envName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to activate conda environment" -ForegroundColor Red
        exit 1
    }
    
    $pythonCmd = "python"
    Write-Host "Conda environment '$envName' created and activated" -ForegroundColor Green
    
} elseif (Test-PythonAvailable) {
    Write-Host "Creating virtual environment with venv..." -ForegroundColor Cyan
    
    # Create virtual environment
    python -m venv $envName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to create virtual environment" -ForegroundColor Red
        exit 1
    }
    
    # Activate virtual environment
    & "$envName\Scripts\Activate.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to activate virtual environment" -ForegroundColor Red
        exit 1
    }
    
    $pythonCmd = "python"
    Write-Host "Virtual environment '$envName' created and activated" -ForegroundColor Green
    
} else {
    Write-Host "Error: Neither conda nor python found. Please install Python or Anaconda." -ForegroundColor Red
    exit 1
}

Write-Host "Using Python: $pythonCmd" -ForegroundColor Cyan

# Install required packages
Write-Host "Installing required packages..." -ForegroundColor Yellow
& $pythonCmd -m pip install --upgrade pip
& $pythonCmd -m pip install -r requirements.txt
& $pythonCmd -m pip install pyinstaller

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to install packages" -ForegroundColor Red
    exit 1
}

# Check assets folder
if (!(Test-Path "assets")) {
    Write-Host "Warning: assets folder not found." -ForegroundColor Red
}

# Build app with PyInstaller
Write-Host "Building app..." -ForegroundColor Yellow
& $pythonCmd -m PyInstaller --onefile --windowed --name "DCMViewer" --icon=assets/icon.ico --add-data "assets;assets" --hidden-import numpy --collect-all numpy app.py

# Build completion message
if ($LASTEXITCODE -eq 0) {
    Write-Host "Build completed! App created at dist/DCMViewer.exe" -ForegroundColor Green
    Start-Process "explorer.exe" -ArgumentList "dist\"
} else {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

# Deactivate environment
if ($usesConda) {
    conda deactivate
} else {
    deactivate
}

Write-Host "Environment deactivated" -ForegroundColor Yellow

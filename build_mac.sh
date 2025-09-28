#!/bin/bash

# macOS app build script

echo "Starting macOS app build..."

# Create and activate conda environment
ENV_NAME="dcmviewer_build"
echo "Creating conda environment: $ENV_NAME"
conda create -n $ENV_NAME python=3.9 -y

# Initialize conda for this shell session
eval "$(conda shell.bash hook)"
conda activate $ENV_NAME
echo "Conda environment activated"

# Install requirements
if [ -f "requirements.txt" ]; then
    echo "Installing requirements from requirements.txt..."
    pip install -r requirements.txt
else
    echo "Warning: requirements.txt not found."
fi

# Install PyInstaller
echo "Installing PyInstaller..."
pip install pyinstaller

# Check assets folder
if [ ! -d "assets" ]; then
    echo "Warning: assets folder not found."
fi

# Build app with PyInstaller
echo "Building app..."
pyinstaller --onefile --windowed --name "DCMViewer" --icon=assets/icon.icns --add-data "assets:assets" --hidden-import numpy --collect-all numpy app.py

# Build completion message
if [ $? -eq 0 ]; then
    echo "Build completed! App created at dist/DCMViewer.app"
    open dist/
else
    echo "Build failed!"
    exit 1
fi

# Cleanup - deactivate and remove conda environment
echo "Cleaning up conda environment..."
conda deactivate
conda remove -n $ENV_NAME --all -y
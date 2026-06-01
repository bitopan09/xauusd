#!/bin/bash
echo "🥇 GoldForge — XAU/USD Trading Bot Setup"
echo "=========================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

echo "📦 Installing backend dependencies..."
npm install

echo ""
echo "📦 Installing frontend dependencies..."
cd frontend && npm install

echo ""
echo "🏗️  Building frontend..."
npm run build
cd ..

echo ""
# Copy .env.example if .env doesn't exist
if [ ! -f .env ]; then
    echo "📋 Creating .env from .env.example..."
    cp .env.example .env
    echo "⚠️  Please update .env with your email credentials and settings."
else
    echo "✅ .env already exists"
fi

echo ""
echo "=========================================="
echo "✅ Setup complete!"
echo ""
echo "Start the bot:  npm start"
echo "Dev mode:       npm run dev:backend  (backend only)"
echo "                npm run dev:frontend (frontend only)"
echo ""
echo "Dashboard:      http://localhost:5002"
echo "=========================================="

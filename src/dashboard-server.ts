#!/usr/bin/env tsx

import path from 'path';
import express from 'express';
import { createLogger } from './utils/logger';

const logger = createLogger('dashboard');
const app = express();
const PORT = 8080;

// Serve static files from public directory (primary)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve static files from scripts directory
app.use('/scripts', express.static(path.join(__dirname, '..', 'scripts')));

// Serve static files from src/dashboard directory (fallback)
app.use('/src-dashboard', express.static(path.join(__dirname, 'dashboard')));

// Serve the dashboard HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Explicit route for ROI calibration tool
app.get('/dashboard/roi-calibration-enhanced.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard', 'roi-calibration-enhanced.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'CardMint Dashboard' });
});


app.listen(PORT, () => {
  logger.info(`Dashboard server running at http://localhost:${PORT}`);
  logger.info(`Open http://localhost:${PORT} in your browser to view the camera`);
});
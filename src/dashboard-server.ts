#!/usr/bin/env tsx

import express from 'express';
import path from 'path';
import { createLogger } from './utils/logger';

const logger = createLogger('dashboard');
const app = express();
const PORT = 8080;

// Serve static files from dashboard directory
app.use(express.static(path.join(__dirname, 'dashboard')));

// Serve the dashboard HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'CardMint Dashboard' });
});

app.listen(PORT, () => {
  logger.info(`Dashboard server running at http://localhost:${PORT}`);
  logger.info(`Open http://localhost:${PORT} in your browser to view the camera`);
});
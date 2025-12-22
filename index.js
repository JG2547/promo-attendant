/**
 * Promo Attendant Service
 * Standalone service for room activity embeds
 *
 * Features:
 * - Auto-updating room status (edits every 10 minutes)
 * - Scheduled reposts (1-24 hours configurable)
 * - DM mode: Users can subscribe to receive updates in their DMs
 * - Group mode: Add to groups via deep link
 * - Admin panel for managing rooms
 */

require('dotenv').config();
const http = require('http');
const { initPromoAttendant, shutdownPromoAttendant } = require('./services/promoAttendant');

// HTTP server for health checks
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'promo-attendant',
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

server.listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
});

console.log('='.repeat(60));
console.log('Promo Attendant Service - Standalone');
console.log('='.repeat(60));
console.log('Features:');
console.log('  - Auto-updating messages (edits every 10 minutes)');
console.log('  - Scheduled reposts (1-24 hours configurable)');
console.log('  - DM mode and Group/Channel mode');
console.log('  - Buttons: + GROUP, + CHANNEL, + DM, MORE INFO');
console.log('  - Admin panel for managing rooms');
console.log('='.repeat(60));

async function startService() {
  console.log('\n[PROMO-ATTENDANT] Initializing...');

  const bot = await initPromoAttendant();
  if (bot) {
    console.log('[PROMO-ATTENDANT] Bot is ready');
  } else {
    console.log('[PROMO-ATTENDANT] Bot disabled (no PROMO_ATTENDANT_BOT_TOKEN)');
  }
}

// Start the service
startService().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Received SIGINT, shutting down...');
  await shutdownPromoAttendant();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[SHUTDOWN] Received SIGTERM, shutting down...');
  await shutdownPromoAttendant();
  process.exit(0);
});

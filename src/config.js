const path = require('node:path');

module.exports = {
  port: Number(process.env.PORT || 3000),
  // Public URL guests will open, e.g. https://rsvp.candiddulhan.com (used in invite links)
  baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  // Optional separate login for the calling team (sees the caller console only)
  callerPassword: process.env.CALLER_PASSWORD || '',
  // Used by the Android phone / automation app to upload call recordings
  apiKey: process.env.API_KEY || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 25),
};

// netlify/functions/load-runsheet.js
//
// Reads the saved emcee run sheet JSON from Drive and returns it.
// Returns { ok: false } if no run sheet has been saved yet.
//
// Required env vars:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN
//   DRIVE_FOLDER_ID

const { google } = require('googleapis');

const RUNSHEET_FILENAME = 'kalasandhya_2026_runsheet.json';

function getAuth() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('OAuth credentials not configured');
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };

  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Drive folder not configured.' }) };

  let auth;
  try { auth = getAuth(); }
  catch (err) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth not configured.' }) }; }

  try {
    const drive = google.drive({ version: 'v3', auth });

    // Find the run sheet file
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and name = '${RUNSHEET_FILENAME}' and trashed = false`,
      fields: 'files(id, modifiedTime)',
      supportsAllDrives: true,
    });

    const files = listRes.data.files || [];
    if (!files.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'no_runsheet' }) };
    }

    // Read the file content
    const contentRes = await drive.files.get(
      { fileId: files[0].id, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );

    let data;
    try { data = JSON.parse(contentRes.data); }
    catch { return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'parse_error' }) }; }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        items: data.items || [],
        filename: data.filename || 'program.pdf',
        savedAt: data.savedAt || files[0].modifiedTime,
      }),
    };
  } catch (err) {
    console.error('load-runsheet failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not load run sheet.' }) };
  }
};

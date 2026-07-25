// netlify/functions/delete-submission.js
//
// Deletes a submission's .info.txt file from Google Drive by file ID.
// Only deletes .info.txt metadata files — never the actual media files.
//
// Required env vars (same as other functions):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN

const { google } = require('googleapis');

function getAuth() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.' }) }; }

  const { fileId } = body;
  if (!fileId || typeof fileId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file ID.' }) };
  }

  let auth;
  try { auth = getAuth(); }
  catch (err) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth not configured.' }) }; }

  try {
    const drive = google.drive({ version: 'v3', auth });

    // Safety check: only delete .info.txt files, never media files
    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });

    const fileName = meta.data.name || '';
    if (!fileName.endsWith('.info.txt')) {
      console.error(`Refused to delete non-info file: ${fileName}`);
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Can only delete .info.txt files.' }) };
    }

    await drive.files.delete({ fileId, supportsAllDrives: true });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: fileId }) };
  } catch (err) {
    console.error('delete-submission failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not delete the submission. Please try again.' }) };
  }
};

// netlify/functions/save-runsheet.js
//
// Saves the emcee run sheet (parsed programs + inserted slots) as a JSON
// file in the configured Drive folder. Overwrites the previous version
// so there is always exactly one current run sheet.
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.' }) }; }

  const { items, filename } = body;
  if (!items || !Array.isArray(items)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'items array is required.' }) };
  }

  const folderId = process.env.DRIVE_SUBMISSIONS_FOLDER_ID || process.env.DRIVE_FOLDER_ID;
  if (!folderId) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Drive folder not configured.' }) };

  let auth;
  try { auth = getAuth(); }
  catch (err) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth not configured.' }) }; }

  try {
    const drive = google.drive({ version: 'v3', auth });
    const accessToken = (await auth.getAccessToken()).token;

    const payload = JSON.stringify({ items, filename, savedAt: new Date().toISOString() });

    // Check if a run sheet file already exists — if so, update it in place
    // so Drive doesn't accumulate multiple copies.
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and name = '${RUNSHEET_FILENAME}' and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
    });

    const existing = listRes.data.files || [];

    if (existing.length > 0) {
      // Update existing file content via PATCH
      const fileId = existing[0].id;
      const patchRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: payload,
        }
      );
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error('Run sheet update failed:', patchRes.status, errText);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not update run sheet in Drive.' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, fileId }) };
    } else {
      // Create new file
      const boundary = 'runsheet2026boundary';
      const metadata = JSON.stringify({ name: RUNSHEET_FILENAME, parents: [folderId] });
      const multipartBody =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${payload}\r\n` +
        `--${boundary}--`;

      const createRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );
      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error('Run sheet create failed:', createRes.status, errText);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not save run sheet to Drive.' }) };
      }
      const fileData = await createRes.json();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, fileId: fileData.id }) };
    }
  } catch (err) {
    console.error('save-runsheet failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save run sheet. Please try again.' }) };
  }
};

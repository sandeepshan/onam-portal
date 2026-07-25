// netlify/functions/add-submission.js
//
// Manually creates an .info.txt file in the configured Drive folder,
// same format as get-upload-url's companion file. Used by the emcee
// dashboard to add programs that didn't come through the upload portal.
//
// Required env vars (same as other functions):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN
//   DRIVE_FOLDER_ID

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

function sanitize(str) {
  return String(str).trim().replace(/[^a-zA-Z0-9\-_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80);
}

function isValidEmail(v) {
  return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
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

  const name        = (body.name || '').trim();
  const email       = (body.email || '').trim();
  const program     = (body.program || '').trim();
  const description = (body.description || '').trim();
  const mediaType   = (body.mediaType || 'manual').trim(); // 'audio', 'video', or 'manual'

  if (!name || !program) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and program are required.' }) };
  }
  if (email && !isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please provide a valid email address.' }) };
  }

  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Drive folder not configured.' }) };

  let auth;
  try { auth = getAuth(); }
  catch (err) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth not configured.' }) }; }

  try {
    const accessToken = (await auth.getAccessToken()).token;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseSlug  = sanitize(program);
    const fileName  = `${baseSlug}_${timestamp}_manual.info.txt`;

    const submittedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });

    const infoContent = [
      `Name: ${name}`,
      `Email: ${email || '(not provided)'}`,
      `Program: ${program}`,
      `Description: ${description || '(none provided)'}`,
      `Submitted: ${submittedAt}`,
      `Media file: (manually added — ${mediaType})`,
    ].join('\n');

    const boundary = 'addsubmission2026';
    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
      `${infoContent}\r\n` +
      `--${boundary}--`;

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('Drive write failed:', uploadRes.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not save to Drive. Please try again.' }) };
    }

    const fileData = await uploadRes.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        fileId: fileData.id,
        submission: {
          name, email, program, description,
          submitted: submittedAt,
          mediaFile: `(manually added — ${mediaType})`,
          _fileId: fileData.id,
          _createdTime: new Date().toISOString(),
        },
      }),
    };
  } catch (err) {
    console.error('add-submission failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save the entry. Please try again.' }) };
  }
};

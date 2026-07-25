// netlify/functions/update-submission.js
//
// Updates an existing .info.txt file in Drive with new content.
// Used by the emcee dashboard to edit manually added or uploaded submissions.
//
// Required env vars: same as other functions

const { google } = require('googleapis');

function getAuth() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('OAuth credentials not configured');
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
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

  const { fileId, name, email, program, description } = body;

  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file ID.' }) };
  }
  if (!name || !program) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and program are required.' }) };
  }
  if (email && !isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email address.' }) };
  }

  let auth;
  try { auth = getAuth(); }
  catch (err) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth not configured.' }) }; }

  try {
    const drive = google.drive({ version: 'v3', auth });
    const accessToken = (await auth.getAccessToken()).token;

    // Safety check — only update .info.txt files
    const meta = await drive.files.get({ fileId, fields: 'id,name', supportsAllDrives: true });
    if (!meta.data.name.endsWith('.info.txt')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Can only edit .info.txt files.' }) };
    }

    const updatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });
    const newContent = [
      `Name: ${name}`,
      `Email: ${email || '(not provided)'}`,
      `Program: ${program}`,
      `Description: ${description || '(none provided)'}`,
      `Submitted: ${updatedAt} (edited)`,
      `Media file: (see original upload)`,
    ].join('\n');

    const patchRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'text/plain',
        },
        body: newContent,
      }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('Update failed:', patchRes.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not update the entry.' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        submission: { name, email, program, description },
      }),
    };
  } catch (err) {
    console.error('update-submission failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not update. Please try again.' }) };
  }
};

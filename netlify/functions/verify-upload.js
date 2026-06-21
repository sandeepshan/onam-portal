// netlify/functions/verify-upload.js
//
// Called by the browser AFTER uploadFileDirectly() reports success, as a
// final double-check before showing the success screen. This queries
// Google Drive directly for the file by its ID and confirms it actually
// exists with the expected size — so "success" shown to the user is
// always backed by a real confirmation from Drive, not just trust in a
// browser-side response that could itself be a false positive/negative
// on a flaky connection.
//
// Required environment variables:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN

const { google } = require('googleapis');

function getAuth() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN must all be set');
  }

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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  const fileId = (body.fileId || '').trim();
  const expectedSize = Number(body.expectedSize) || 0;

  if (!fileId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No file ID was provided to verify.' }) };
  }

  let auth;
  try {
    auth = getAuth();
  } catch (err) {
    console.error('Auth setup failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Verification service is not configured.' }) };
  }

  try {
    const accessToken = (await auth.getAccessToken()).token;

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,webViewLink&supportsAllDrives=true`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error('Verify lookup failed:', res.status, errText);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ verified: false, reason: 'not_found' }),
      };
    }

    const fileData = await res.json();
    const actualSize = Number(fileData.size) || 0;

    // Allow exact match only — for a fully-completed Drive upload, the
    // reported size should match precisely. A mismatch likely means a
    // partial/interrupted file masquerading as the right one.
    const sizeMatches = expectedSize === 0 || actualSize === expectedSize;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        verified: sizeMatches,
        reason: sizeMatches ? null : 'size_mismatch',
        actualSize,
        expectedSize,
        webViewLink: fileData.webViewLink || '',
        name: fileData.name || '',
      }),
    };
  } catch (err) {
    console.error('verify-upload failed:', err.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ verified: false, reason: 'error' }),
    };
  }
};

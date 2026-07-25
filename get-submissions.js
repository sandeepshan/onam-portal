// netlify/functions/get-submissions.js
//
// Reads all .info.txt files from the configured Drive folder and returns
// them as a parsed JSON array for the submissions dashboard.
//
// Required environment variables (same as get-upload-url):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN
//   DRIVE_FOLDER_ID

const { google } = require('googleapis');

function getAuth() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('OAuth credentials not configured');
  }

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

function parseInfoFile(text) {
  const lines = text.split('\n');
  const result = {};
  let currentKey = null;
  let currentValue = [];

  for (const line of lines) {
    // Match "Key: value" at the start of a line
    const match = line.match(/^(Name|Email|Program|Description|Submitted|Media file):\s*(.*)/);
    if (match) {
      // Save previous key if any
      if (currentKey) {
        result[currentKey] = currentValue.join('\n').trim();
      }
      currentKey = match[1];
      currentValue = [match[2]];
    } else if (currentKey) {
      // Continuation of a multi-line value (e.g. Description)
      currentValue.push(line);
    }
  }
  // Save last key
  if (currentKey) {
    result[currentKey] = currentValue.join('\n').trim();
  }

  return {
    name: result['Name'] || '',
    email: result['Email'] || '',
    program: result['Program'] || '',
    description: result['Description'] || '',
    submitted: result['Submitted'] || '',
    mediaFile: result['Media file'] || '',
  };
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Drive folder not configured.' }) };
  }

  let auth;
  try {
    auth = getAuth();
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth not configured.' }) };
  }

  try {
    const drive = google.drive({ version: 'v3', auth });

    // List all .info.txt files in the folder, newest first
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and name contains '.info.txt' and trashed = false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 200,
      supportsAllDrives: true,
    });

    const files = listRes.data.files || [];

    // Fetch content of each info file in parallel (capped at 20 concurrent)
    const BATCH = 20;
    const submissions = [];

    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const contentRes = await drive.files.get(
              { fileId: file.id, alt: 'media', supportsAllDrives: true },
              { responseType: 'text' }
            );
            const parsed = parseInfoFile(contentRes.data);
            return { ...parsed, _fileId: file.id, _createdTime: file.createdTime };
          } catch (err) {
            console.error(`Failed to read file ${file.id}:`, err.message);
            return null;
          }
        })
      );
      submissions.push(...results.filter(Boolean));
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, count: submissions.length, submissions }),
    };
  } catch (err) {
    console.error('get-submissions failed:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not load submissions. Please try again.' }),
    };
  }
};

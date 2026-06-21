// netlify/functions/get-upload-url.js
//
// Mints a Google Drive "resumable upload session" URL using OAuth
// credentials authorized by the organiser's own Google account, and hands
// it back to the browser. The browser then uploads the file bytes
// DIRECTLY to that URL (Google's servers), bypassing Netlify's function
// execution time limit entirely. This function itself only ever makes one
// quick API call for the session, plus a small companion text file
// upload, so it finishes in well under a second.
//
// Alongside the resumable session, this function also writes a small
// ".txt" info file into the same Drive folder with the same base name as
// the upcoming media file. It records name, email, program, and
// description, so that information isn't lost even without a Sheets log.
//
// Required environment variables:
//   GOOGLE_OAUTH_CLIENT_ID       - OAuth client ID from Google Cloud
//   GOOGLE_OAUTH_CLIENT_SECRET   - OAuth client secret from Google Cloud
//   GOOGLE_OAUTH_REFRESH_TOKEN   - refresh token from the one-time authorize step
//   DRIVE_FOLDER_ID              - destination Drive folder ID
//
// Because this uses OAuth (the organiser's own account) rather than a
// service account, uploaded files are owned by the organiser's personal
// Google account and count against their normal Drive storage — this
// avoids the "Service Accounts do not have storage quota" error that
// occurs on personal (non-Workspace) Gmail accounts.

const { google } = require('googleapis');

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function sanitizeForFilename(str) {
  return String(str)
    .trim()
    .replace(/[^a-zA-Z0-9\-_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

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

  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const program = (body.program || '').trim();
  const description = (body.description || '').trim();
  const fileName = (body.fileName || '').trim();
  const fileSize = Number(body.fileSize) || 0;
  const mimeType = (body.mimeType || '').trim();

  if (!name || !email || !program) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name, email, and program name are all required.' }) };
  }
  if (!isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please provide a valid email address.' }) };
  }
  if (!fileName || !mimeType) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No file information was received.' }) };
  }
  if (!(mimeType.startsWith('audio') || mimeType.startsWith('video'))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please upload an audio or video file.' }) };
  }

  const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB ceiling, generous for event video
  if (fileSize > MAX_BYTES) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'That file is larger than 2GB. Please compress it or trim the clip.' }) };
  }

  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    console.error('DRIVE_FOLDER_ID is not configured');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'The upload destination is not configured yet. Please contact the organiser.' }) };
  }

  let auth;
  try {
    auth = getAuth();
  } catch (err) {
    console.error('Auth setup failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upload service is not configured yet. Please contact the organiser.' }) };
  }

  // Build the destination filename: ProgramName_PersonName_timestamp.ext
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const driveFileName = `${sanitizeForFilename(program)}_${sanitizeForFilename(name)}_${timestamp}${ext}`;

  try {
    const accessToken = (await auth.getAccessToken()).token;

    // Initiate a resumable upload session directly via Drive's REST API.
    // (The googleapis client library doesn't expose a "give me the session
    // URL and let the browser do the rest" mode, so we call the REST
    // endpoint ourselves to get the Location header back.)
    const initRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          ...(fileSize ? { 'X-Upload-Content-Length': String(fileSize) } : {}),
        },
        body: JSON.stringify({
          name: driveFileName,
          parents: [folderId],
        }),
      }
    );

    if (!initRes.ok) {
      const errText = await initRes.text();
      console.error('Drive session init failed:', initRes.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'We could not start the upload right now. Please try again in a moment.' }),
      };
    }

    const sessionUrl = initRes.headers.get('location');
    if (!sessionUrl) {
      console.error('Drive did not return a session URL');
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'We could not start the upload right now. Please try again in a moment.' }),
      };
    }

    // Best-effort: write a small companion .txt file with the submission
    // details, using the same base name as the media file. This is the
    // only place name/email/program/description are recorded, so it's
    // worth trying, but a failure here should never block the actual
    // upload the user is waiting on.
    const infoFileName = `${driveFileName}.info.txt`;
    const infoContent = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Program: ${program}`,
      `Description: ${description || '(none provided)'}`,
      `Submitted: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}`,
      `Media file: ${driveFileName}`,
    ].join('\n');

    try {
      const boundary = 'onam2026boundary';
      const metadata = JSON.stringify({ name: infoFileName, parents: [folderId] });
      const multipartBody =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
        `${infoContent}\r\n` +
        `--${boundary}--`;

      const infoRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );
      if (!infoRes.ok) {
        const errText = await infoRes.text();
        console.error('Info file upload failed (continuing anyway):', infoRes.status, errText);
      }
    } catch (infoErr) {
      console.error('Info file upload threw (continuing anyway):', infoErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        uploadUrl: sessionUrl,
        driveFileName,
      }),
    };
  } catch (err) {
    console.error('get-upload-url failed:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'We could not start the upload right now. Please try again in a moment.' }),
    };
  }
};

// netlify/functions/upload-chunk.js
//
// Receives one chunk of a file from the browser and forwards it to
// Google's resumable upload session URL on the server side. This exists
// because direct browser-to-Google PUT requests to the resumable session
// URL hit unreliable CORS behavior in practice — Google's resumable
// upload endpoint does not consistently return the
// Access-Control-Allow-Origin header needed for cross-origin requests
// with custom headers like Content-Range, so the browser blocks reading
// the response even when the underlying request may have succeeded.
//
// Routing through this same-origin function avoids CORS entirely: the
// browser talks to its own domain, and this function (running
// server-side, where CORS doesn't apply) talks to Google directly.
//
// Each invocation only forwards a single small chunk (a few MB), so even
// very large files stay well within Netlify's function execution time
// limit — only the per-chunk forward has to complete within that window,
// not the whole file transfer.
//
// The browser sends:
//   - Header "X-Upload-Url": the full Google resumable session URL
//   - Header "X-Content-Range": the Content-Range value for this chunk
//   - Body: the raw chunk bytes
//
// This function returns Google's response status and headers (notably
// the Range header on a 308, or the file JSON on 200/201) back to the
// browser as JSON, since the browser can't read Google's raw headers
// directly either (same CORS issue) — but it CAN always read our own
// same-origin function's response without restriction.

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Url, X-Content-Range',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const uploadUrl = event.headers['x-upload-url'] || event.headers['X-Upload-Url'];
  const contentRange = event.headers['x-content-range'] || event.headers['X-Content-Range'];

  if (!uploadUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing upload URL.' }) };
  }

  // Basic safety check: only ever forward to Google's own domain, never
  // wherever a request claims to want to go. This function should not be
  // usable as an open proxy to arbitrary URLs.
  let parsedUrl;
  try {
    parsedUrl = new URL(uploadUrl);
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid upload URL.' }) };
  }
  if (parsedUrl.hostname !== 'www.googleapis.com') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Upload URL must point to Google APIs.' }) };
  }

  try {
    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'utf8');

    const googleHeaders = {};
    if (contentRange) {
      googleHeaders['Content-Range'] = contentRange;
    }

    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: googleHeaders,
      body: bodyBuffer,
    });

    const status = res.status;

    if (status === 200 || status === 201) {
      const fileData = await res.json().catch(() => ({}));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ done: true, fileInfo: fileData }),
      };
    }

    if (status === 308) {
      const range = res.headers.get('range'); // e.g. "bytes=0-1048575"
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ done: false, range: range || null }),
      };
    }

    // Anything else is an unexpected response from Google — surface it
    // so the browser's retry logic can re-sync and try again.
    const errText = await res.text().catch(() => '');
    console.error('Unexpected status forwarding chunk to Drive:', status, errText);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ done: false, error: true, status, detail: errText.slice(0, 500) }),
    };
  } catch (err) {
    console.error('upload-chunk failed:', err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Could not forward this chunk to Drive. Please try again.' }),
    };
  }
};

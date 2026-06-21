# Onam 2026 Upload Portal — Setup Guide

This covers what to do once you have your Google service account JSON key.
Everything here happens in Netlify's dashboard and Google Drive — no code
editing required.

## How this works (architecture)

Because your Netlify plan has a 10-second function execution limit, and
video files can take much longer than that to upload, the file itself is
**not** sent through a Netlify function. Instead:

1. Browser sends the form fields (name, email, program, description, file
   metadata) to `get-upload-url` — a fast function that asks Google Drive
   for a temporary "resumable upload session" URL, and also writes a small
   companion `.txt` info file (with the name/email/program/description)
   into the same Drive folder. This all takes well under a second.
2. The browser then uploads the file **directly to Google's servers**
   using that session URL. Netlify is no longer involved in this step at
   all, so there's no 10-second limit on it — it can take as long as the
   file needs.

Each submission ends up as two files side by side in your Drive folder:
- `ProgramName_Name_timestamp.mp4` — the actual media file
- `ProgramName_Name_timestamp.mp4.info.txt` — a plain text file with the
  submitter's name, email, program name, description, and submission time

This means large video files (up to 2GB) work reliably even on your
current Netlify plan, and you keep a record of who submitted what without
needing a separate Google Sheet.

## 1. Files in this project

```
onam-portal/
├── index.html                          ← the upload form
├── netlify.toml                        ← Netlify build config
├── package.json                        ← dependencies (googleapis)
└── netlify/
    └── functions/
        └── get-upload-url.js             ← mints the Drive upload session + writes the info file
```

## 2. Deploy to Netlify

1. Push this whole folder to a GitHub repo (or drag-and-drop the folder
   into Netlify's "Deploys" tab if you'd rather skip GitHub for now).
2. In Netlify, create a new site from that repo/folder.
3. Build settings should auto-detect from `netlify.toml`. No build command
   is needed — it's a static file plus one small function.

## 3. Add environment variables in Netlify

Go to **Site settings → Environment variables** and add:

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Paste the **entire contents** of the downloaded JSON key file, as-is, as one value |
| `DRIVE_FOLDER_ID` | The folder ID from your Drive folder's URL |

**On `GOOGLE_SERVICE_ACCOUNT_KEY`:** paste the raw JSON exactly as it
appears in the downloaded file (starts with `{"type": "service_account", ...`).
Don't reformat it or wrap it in extra quotes — Netlify's environment
variable field handles the full text fine as one entry.

## 4. Redeploy

After adding environment variables, trigger a redeploy (Netlify doesn't
always pick up new env vars on already-built functions). **Deploys → Trigger
deploy → Deploy site** is the simplest way.

## 5. Test it

1. Open your live Netlify URL.
2. Fill in the form with a test audio/video file — try a small one first,
   then a larger one (50–100MB+) to confirm the direct-upload path works.
3. Submit.
4. Check your Drive folder for:
   - The media file, named like `ProgramName_YourName_2026-06-21T...mp4`
   - A matching `....info.txt` file alongside it with the submission details
5. You should also see the success screen in the browser.

## Troubleshooting

**"Upload service is not configured yet" / "destination is not configured yet"**
→ `GOOGLE_SERVICE_ACCOUNT_KEY` or `DRIVE_FOLDER_ID` is missing, or the JSON
didn't parse. Re-check the environment variable value and redeploy.

**"We could not start the upload right now"**
→ Usually means the service account doesn't have access to the Drive
folder. Re-confirm you shared the folder with the service account's
`client_email` (found inside the JSON key) with Editor access. Check the
function logs (Netlify → Functions → get-upload-url → Logs) for the exact
Google API error.

**Media file uploads but the `.info.txt` file is missing**
→ The info file upload is intentionally best-effort and silent to the
user — a failure there never blocks the main upload. Check Netlify's
function logs (Functions → get-upload-url → Logs) around the time of that
submission for an "Info file upload failed" or "threw" message, which will
show the underlying Google API error.

**Upload starts but stalls or fails partway through a large file**
→ Resumable sessions expire after a period of inactivity, and the browser
tab must stay open/foregrounded on mobile for some browsers to keep
uploading. If this becomes a recurring issue with very large files, we can
add automatic retry/resume logic — flag it and we'll build that next.

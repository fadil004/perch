// Link inbox: links saved on the phone wait in Drive until Video Grabber (inside Eagle on the computer)
// downloads them into the library.
//
// Each link is one small JSON file in "My Drive/Perch Inbox". Google Drive for desktop syncs that folder
// to the computer, where the plugin reads it, downloads the video with yt-dlp, adds it to Eagle and
// writes the outcome back into the same file (status, title, error). Perch only ever creates files here
// (drive.file scope) and reads them back for the status list.
import { FOLDER } from './drive.js';
import { lsGet, lsSet } from './util.js';

export const INBOX_NAME = 'Perch Inbox';
const folderKey = (modeKey) => `perch.inbox.${modeKey}`;
const REQUEST_NAME = /^\d{13}-[a-z0-9]+\.json$/;

/** The first http(s) link in whatever an app shared (some put it in the text, some in the title). */
export function extractUrl(...parts) {
  for (const p of parts) {
    const m = String(p || '').match(/https?:\/\/[^\s<>"']+/i);
    if (m) return m[0].replace(/[.,;:!?)\]}>]+$/, '');
  }
  return '';
}

async function inboxFolder(drive, modeKey, { create = false } = {}) {
  const cached = lsGet(folderKey(modeKey));
  if (cached) return cached;
  const q = `name = '${INBOX_NAME}' and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`;
  const hits = await drive.list(q, 'id,name,createdTime');
  hits.sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')));
  let id = hits.length ? hits[0].id : null;
  if (!id && create) id = (await drive.createFolder(INBOX_NAME)).id;
  if (id) lsSet(folderKey(modeKey), id);
  return id;
}

/** Save one link for Eagle. Resolves with the created Drive file. */
export async function saveLink(drive, modeKey, { url, library }) {
  const request = {
    v: 1,
    url,
    library: library ? library.name.replace(/\.library$/i, '') : '',
    sentAt: new Date().toISOString(),
    from: 'Perch',
    status: 'pending',
  };
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const body = JSON.stringify(request, null, 2);
  const folder = await inboxFolder(drive, modeKey, { create: true });
  try {
    return await drive.createFile(name, [folder], body);
  } catch (e) {
    // A folder this app didn't make (or one since deleted) can't take new files: make our own.
    if (e.name !== 'DriveError' || (e.status !== 403 && e.status !== 404) || /insufficient|scope/i.test(e.message)) throw e;
    lsSet(folderKey(modeKey), null);
    const own = (await drive.createFolder(INBOX_NAME)).id;
    lsSet(folderKey(modeKey), own);
    return drive.createFile(name, [own], body);
  }
}

/** The latest links with their status as the plugin reported it, newest first. */
export async function recentLinks(drive, modeKey, n = 6) {
  const folder = await inboxFolder(drive, modeKey);
  if (!folder) return [];
  const files = (await drive.list(`'${folder}' in parents and trashed = false`, 'id,name,modifiedTime'))
    .filter((f) => REQUEST_NAME.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, n);
  return Promise.all(files.map(async (f) => {
    try { return { id: f.id, ...(await drive.json(f.id)) }; } catch { return { id: f.id, status: 'unknown' }; }
  }));
}

/** "instagram.com" from a URL, for compact rows. */
export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^(www|m)\./, ''); } catch { return url; }
}

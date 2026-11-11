// Inbox: what the phone sends to Eagle waits in "My Drive/Perch Inbox" until Video Grabber (inside Eagle on
// the computer) picks it up. Google Drive for desktop syncs that folder to the computer.
//
// Each request is one small JSON file. A link: the plugin downloads it with yt-dlp. A video the phone
// already has: Perch uploads it next to the request and the plugin only adds it to Eagle. Either way the
// plugin writes the outcome back into the same JSON (status, title, error). Perch only ever creates files
// here (drive.file scope) and reads them back for the status list.
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

/**
 * Run fn(folderId) against the inbox. A folder this app didn't make (or one since deleted) can't take new
 * files under drive.file: then make our own and try once more.
 */
export async function withInbox(drive, modeKey, fn) {
  const folder = await inboxFolder(drive, modeKey, { create: true });
  try {
    return await fn(folder);
  } catch (e) {
    if (e.name !== 'DriveError' || (e.status !== 403 && e.status !== 404) || /insufficient|scope/i.test(e.message)) throw e;
    lsSet(folderKey(modeKey), null);
    const own = (await drive.createFolder(INBOX_NAME)).id;
    lsSet(folderKey(modeKey), own);
    return fn(own);
  }
}

const libraryName = (library) => (library ? library.name.replace(/\.library$/i, '') : '');
export const newStem = (t = Date.now()) => `${t}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

/** Save one link for Eagle (Video Grabber downloads it on the computer). Resolves with the created Drive file. */
export async function saveLink(drive, modeKey, { url, library }) {
  const request = { v: 1, url, library: libraryName(library), sentAt: new Date().toISOString(), from: 'Perch', status: 'pending' };
  const body = JSON.stringify(request, null, 2);
  const name = `${newStem()}.json`;
  return withInbox(drive, modeKey, (folder) => drive.createFile(name, [folder], body));
}

/**
 * The request next to a video uploaded from the phone: Eagle only has to add the file, nothing to download.
 * `file` is the uploaded file's name in the same folder; `name` is what the phone called it.
 */
export async function saveFileRequest(drive, folder, { stem, file, name, size, mimeType, url = '', library }) {
  const request = { v: 1, kind: 'file', file, name, size, mimeType, url, library: libraryName(library), sentAt: new Date().toISOString(), from: 'Perch', status: 'pending' };
  return drive.createFile(`${stem}.json`, [folder], JSON.stringify(request, null, 2));
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

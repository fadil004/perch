// Inbox: what the phone sends to Eagle waits in "My Drive/Perch Inbox" until Video Grabber (inside Eagle on
// the computer) picks it up. Google Drive for desktop syncs that folder to the computer.
//
// Each request is one small JSON file. A link: the plugin downloads it with yt-dlp. A video the phone
// already has: Perch uploads it next to the request and the plugin only adds it to Eagle. Either way the
// plugin writes the outcome back into the same JSON (status, title, error). A delete: the plugin moves the
// item to Eagle's Trash. Perch only ever creates files here (drive.file scope), reads them back for the
// status list, and may move its own files to the bin (a video deleted before Eagle added it).
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

// First-time creation is shared: two saves at once must not make two "Perch Inbox" folders.
const making = new Map();   // modeKey -> promise of the new folder's id
function makeInbox(drive, modeKey) {
  if (!making.has(modeKey)) {
    making.set(modeKey, drive.createFolder(INBOX_NAME).then((f) => { lsSet(folderKey(modeKey), f.id); return f.id; })
      .finally(() => making.delete(modeKey)));
  }
  return making.get(modeKey);
}

async function inboxFolder(drive, modeKey, { create = false } = {}) {
  const cached = lsGet(folderKey(modeKey));
  if (cached) return cached;
  if (making.has(modeKey)) return making.get(modeKey);
  const q = `name = '${INBOX_NAME}' and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`;
  const hits = await drive.list(q, 'id,name,createdTime');
  hits.sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')));
  let id = hits.length ? hits[0].id : null;
  if (!id && create) return makeInbox(drive, modeKey);
  if (id) lsSet(folderKey(modeKey), id);
  return id;
}

/** List the inbox's files. A remembered folder id that Drive no longer knows (404) is dropped and looked up again once. */
async function listInbox(drive, modeKey, fields) {
  for (let again = 0; ; again++) {
    const folder = await inboxFolder(drive, modeKey);
    if (!folder) return null;
    try {
      return await drive.list(`'${folder}' in parents and trashed = false`, fields);
    } catch (e) {
      if (again || e.name !== 'DriveError' || e.status !== 404) throw e;
      if (lsGet(folderKey(modeKey)) === folder) lsSet(folderKey(modeKey), null);
    }
  }
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
    if (lsGet(folderKey(modeKey)) === folder) lsSet(folderKey(modeKey), null);
    const own = lsGet(folderKey(modeKey)) || (await makeInbox(drive, modeKey));   // another save may have made it meanwhile
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
  // Already there (an earlier try was created although its answer never came back): never write it twice.
  const q = `name = '${stem}.json' and '${folder}' in parents and trashed = false`;
  const hit = (await drive.list(q, 'id,name')).find((f) => f.name === `${stem}.json`);
  if (hit) return hit;
  const request = { v: 1, kind: 'file', file, name, size, mimeType, url, library: libraryName(library), sentAt: new Date().toISOString(), from: 'Perch', status: 'pending' };
  return drive.createFile(`${stem}.json`, [folder], JSON.stringify(request, null, 2));
}

/** Ask Eagle to move an item to its Trash (the item was deleted in Perch). `stem` is chosen by the caller, so a retry writes the same name. */
export async function saveDelete(drive, modeKey, { stem, item, name, library }) {
  const request = { v: 1, kind: 'delete', item, name, library: libraryName(library), sentAt: new Date().toISOString(), from: 'Perch', status: 'pending' };
  return withInbox(drive, modeKey, (folder) => drive.createFile(`${stem}.json`, [folder], JSON.stringify(request, null, 2)));
}

/** The latest links with their status as the plugin reported it, newest first. */
export async function recentLinks(drive, modeKey, n = 6) {
  const all = await listInbox(drive, modeKey, 'id,name,modifiedTime');
  if (!all) return [];
  const files = all
    .filter((f) => REQUEST_NAME.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, n);
  return Promise.all(files.map(async (f) => {
    try { return { id: f.id, ...(await drive.json(f.id)) }; } catch { return { id: f.id, status: 'unknown' }; }
  }));
}

const CACHE_KEY = (modeKey) => `perch.inbox.cache.${modeKey}`;
const KEEP = ['kind', 'file', 'name', 'size', 'mimeType', 'url', 'library', 'sentAt', 'status', 'title', 'doneAt', 'item', 'error'];
const VIDEO_FIELDS = 'id,name,size,mimeType,modifiedTime,thumbnailLink,videoMediaMetadata,imageMediaMetadata';

/**
 * Every video sent from the phone ('file' requests), newest first, each with its video's Drive file
 * (`video`, null once the plugin has removed it), and every delete request (`deletes`). One list of the
 * inbox; a request's JSON is only read again when Drive says it changed, so a refresh costs one call when
 * nothing happened.
 */
export async function inboxRequests(drive, modeKey) {
  const files = await listInbox(drive, modeKey, VIDEO_FIELDS);
  if (!files) return { files: [], deletes: [] };
  const byName = new Map(files.map((f) => [f.name, f]));
  const old = lsGet(CACHE_KEY(modeKey), {}) || {};
  const cache = {};
  const reqs = [];
  await Promise.all(files.filter((f) => REQUEST_NAME.test(f.name)).map(async (f) => {
    let body = old[f.id] && old[f.id].m === f.modifiedTime ? old[f.id].b : null;
    let m = f.modifiedTime;
    if (!body) {
      try {
        body = await drive.json(f.id);
        body = Object.fromEntries(KEEP.filter((k) => body[k] != null).map((k) => [k, body[k]]));
      } catch (e) {
        // One failed read must not make a request vanish: keep what was read before (and read it again next
        // time), or, never read yet, fail the whole answer so the caller keeps its last good one.
        if (!old[f.id]) throw e;
        body = old[f.id].b;
        m = old[f.id].m;
      }
    }
    cache[f.id] = { m, b: body };
    reqs.push({ ...body, id: f.id, stem: f.name.replace(/\.json$/, ''), m: f.modifiedTime || '' });
  }));
  lsSet(CACHE_KEY(modeKey), cache);
  // Two request files with the same name (a create retried after its answer was lost): one entry, the one
  // written last (the plugin's answer lands there).
  const byStem = new Map();
  for (const r of reqs) { const o = byStem.get(r.stem); if (!o || r.m > o.m || (r.m === o.m && r.id > o.id)) byStem.set(r.stem, r); }
  const out = [], deletes = [];
  for (const { m, ...r } of byStem.values()) {
    if (r.kind === 'file') out.push({ ...r, video: byName.get(r.file) || null });
    else if (r.kind === 'delete') deletes.push(r);
  }
  return { files: out.sort((a, b) => b.stem.localeCompare(a.stem)), deletes };
}

/** Only the 'file' requests (see inboxRequests). */
export async function fileRequests(drive, modeKey) {
  return (await inboxRequests(drive, modeKey)).files;
}

/** "instagram.com" from a URL, for compact rows. */
export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^(www|m)\./, ''); } catch { return url; }
}

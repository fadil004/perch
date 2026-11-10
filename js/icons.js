// Inline SVG icons, 24px grid, 1.5px stroke (stroke/fill set in CSS).
const s = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const dot = (cx, cy, r = 1.3) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

export const I = {
  folders: s('<path d="M3.75 7.25a2 2 0 0 1 2-2h3.5l2 2.25h7a2 2 0 0 1 2 2v7.25a2 2 0 0 1-2 2h-12.5a2 2 0 0 1-2-2z"/>'),
  search: s('<circle cx="10.75" cy="10.75" r="6.25"/><path d="m15.5 15.5 4.75 4.75"/>'),
  more: s(dot(5.5, 12) + dot(12, 12) + dot(18.5, 12)),
  close: s('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  info: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 10.75v5.75"/>' + dot(12, 7.75, 1)),
  chevronR: s('<path d="m9.5 6 6 6-6 6"/>'),
  chevronD: s('<path d="m7 10 5 5 5-5"/>'),
  play: s('<path d="M8.25 5.9v12.2c0 .5.55.8.97.53l9.6-6.1a.63.63 0 0 0 0-1.06l-9.6-6.1a.63.63 0 0 0-.97.53z" fill="currentColor" stroke="none"/>'),
  pause: s('<rect x="7" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" stroke="none"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" stroke="none"/>'),
  muted: s('<path d="M4.75 9.5h2.75l4-3.5v12l-4-3.5H4.75a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path d="m15.75 9.75 4.5 4.5m0-4.5-4.5 4.5"/>'),
  sound: s('<path d="M4.75 9.5h2.75l4-3.5v12l-4-3.5H4.75a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path d="M15.5 9.25a3.9 3.9 0 0 1 0 5.5M18.1 6.75a7.5 7.5 0 0 1 0 10.5"/>'),
  link: s('<path d="M10.25 13.75a3.75 3.75 0 0 0 5.3 0l2.95-2.95a3.75 3.75 0 0 0-5.3-5.3l-1.05 1.05"/><path d="M13.75 10.25a3.75 3.75 0 0 0-5.3 0L5.5 13.2a3.75 3.75 0 0 0 5.3 5.3l1.05-1.05"/>'),
  external: s('<path d="M13.5 5.25h5.25v5.25M18.75 5.25 11 13"/><path d="M17.25 13.5v4a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5V8a1.5 1.5 0 0 1 1.5-1.5h4"/>'),
  lock: s('<rect x="5.5" y="10.5" width="13" height="9" rx="2.25"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  check: s('<path d="m5.5 12.5 4 4 9-9"/>'),
  sync: s('<path d="M19.25 12A7.25 7.25 0 0 1 6.6 16.85M4.75 12A7.25 7.25 0 0 1 17.4 7.15"/><path d="M17.75 3.75v3.6h-3.6M6.25 20.25v-3.6h3.6"/>'),
  library: s('<rect x="4.25" y="4.25" width="6.5" height="6.5" rx="1.6"/><rect x="13.25" y="4.25" width="6.5" height="6.5" rx="1.6"/><rect x="4.25" y="13.25" width="6.5" height="6.5" rx="1.6"/><rect x="13.25" y="13.25" width="6.5" height="6.5" rx="1.6"/>'),
  stack: s('<path d="M12 4.25 20 8.5l-8 4.25L4 8.5z"/><path d="m4 12.25 8 4.25 8-4.25"/><path d="m4 15.75 8 4.25 8-4.25"/>'),
  signout: s('<path d="M13.5 7.25V5.75a1.5 1.5 0 0 0-1.5-1.5H6.25a1.5 1.5 0 0 0-1.5 1.5v12.5a1.5 1.5 0 0 0 1.5 1.5H12a1.5 1.5 0 0 0 1.5-1.5v-1.5"/><path d="M9.75 12h10.5m-3-3 3 3-3 3"/>'),
  columns: s('<rect x="4.25" y="4.25" width="15.5" height="15.5" rx="2.5"/><path d="M12 4.25v15.5"/>'),
  star: s('<path d="m12 4.6 2.25 4.6 5.05.73-3.65 3.57.86 5.03L12 16.15l-4.51 2.38.86-5.03-3.65-3.57 5.05-.73z"/>'),
  all: s('<rect x="4.25" y="4.25" width="6.5" height="9" rx="1.6"/><rect x="13.25" y="4.25" width="6.5" height="5.5" rx="1.6"/><rect x="4.25" y="15.75" width="6.5" height="4" rx="1.4"/><rect x="13.25" y="12.25" width="6.5" height="7.5" rx="1.6"/>'),
  inbox: s('<path d="M4.25 13.25 6.6 6.2a1.5 1.5 0 0 1 1.42-1.03h7.96a1.5 1.5 0 0 1 1.42 1.03l2.35 7.05"/><path d="M4.25 13.25v4.5a1.5 1.5 0 0 0 1.5 1.5h12.5a1.5 1.5 0 0 0 1.5-1.5v-4.5h-4.5l-1.25 2h-4l-1.25-2z"/>'),
  drive: s('<path d="M8.6 4.75h6.8l5.35 9.25-3.4 5.25H6.65L3.25 14z"/><path d="m8.6 4.75 5.4 9.25H3.25M15.4 4.75 9.95 14M17.35 19.25 14 14"/>'),
  copy: s('<rect x="8.25" y="8.25" width="11.5" height="11.5" rx="2"/><path d="M15.75 8.25v-2a2 2 0 0 0-2-2h-7.5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2"/>'),
  x: s('<path d="M7 7l10 10M17 7 7 17"/>'),
  // iOS share glyph (square + up arrow), Android overflow menu, "add to home screen" square.
  share: s('<path d="M12 3.75v10.5"/><path d="m8.4 7.1 3.6-3.4 3.6 3.4"/><path d="M8.75 10.25h-1.5a1.5 1.5 0 0 0-1.5 1.5v7a1.5 1.5 0 0 0 1.5 1.5h9.5a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1.5"/>'),
  menuV: s(dot(12, 5.5, 1.5) + dot(12, 12, 1.5) + dot(12, 18.5, 1.5)),
  plusSquare: s('<rect x="4.25" y="4.25" width="15.5" height="15.5" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
  // Brand-neutral mark: a dot resting on a perch.
  mark: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="29.5" cy="21.5" r="5.5" fill="currentColor" stroke="none"/><path d="M9 31h30" stroke-width="2.6"/></svg>`,
};

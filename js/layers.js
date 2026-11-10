// Overlays (viewer, sheets, search) each own one history entry, so Android's back gesture and the
// browser back button close the top layer instead of leaving the app.
const stack = [];
let seq = 0;
let skipPops = 0;

// A reload can land on an entry pushed by the previous page instance; make it the clean base again.
if (history.state && history.state.perchLayer) history.replaceState(null, '');

export const layers = {
  push(close) {
    const id = ++seq;
    stack.push({ id, close });
    try { history.pushState({ perchLayer: id }, ''); } catch { /* ignore */ }
    return id;
  },
  /** Called when a layer closed itself through the UI. */
  remove(id) {
    const i = stack.findIndex((l) => l.id === id);
    if (i < 0) return;
    stack.splice(i, 1);
    if (history.state && history.state.perchLayer) { skipPops++; history.back(); }
  },
  get depth() { return stack.length; },
};

addEventListener('popstate', () => {
  if (skipPops > 0) { skipPops--; return; }
  const top = stack.pop();
  if (top) top.close();
});

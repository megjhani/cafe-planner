// Who may do what, shared by the planner and the money page. The database rules
// (firestore.rules) enforce the same roles, so changing this file alone grants nothing.
//
//   owner  the main owner (OWNER_EMAIL): everything, and the only one who changes access
//   edit   listed in cafe/admins "emails": everything except changing access
//   view   listed in cafe/admins "viewers": sees the planner, pay and money pages, changes nothing
//   staff  everyone else: only their own availability grid
//
// Owners, editors and viewers are signed out after IDLE_MINUTES without activity and when
// the browser closes. Staff stay signed in.
export const IDLE_MINUTES = 30;

export async function roleOf(fs, db, mail, mainOwner) {
  if (mainOwner && mail === mainOwner) return 'owner';
  try {
    const s = await fs.getDoc(fs.doc(db, 'cafe', 'admins'));
    const d = s.exists() ? s.data() : {};
    if ((d.emails || []).includes(mail)) return 'edit';
    if ((d.viewers || []).includes(mail)) return 'view';
    return 'staff';
  } catch (e) {
    if (e.code === 'permission-denied') return 'staff';
    throw e;
  }
}

// Keep the sign-in only for this browser session, and sign out after a quiet spell.
// A sleeping tab's timer can be late, so the elapsed time is also checked when the tab returns.
export function ownerSession(authMod, auth, onExpire) {
  authMod.setPersistence(auth, authMod.browserSessionPersistence).catch(() => {});
  const limit = IDLE_MINUTES * 60000;
  let last = Date.now(), timer = null, done = false;
  const expire = () => { if (!done) { done = true; onExpire(); } };
  const poke = () => { last = Date.now(); clearTimeout(timer); timer = setTimeout(expire, limit); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => addEventListener(ev, poke, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > limit) expire(); });
  poke();
}

export const IDLE_NOTE_KEY = 'signedOutIdle';
export const idleMessage = () => {
  let was = false;
  try { was = sessionStorage.getItem(IDLE_NOTE_KEY) === '1'; sessionStorage.removeItem(IDLE_NOTE_KEY); } catch {}
  return was ? `You were signed out after ${IDLE_MINUTES} minutes without activity.` : '';
};
export const markIdle = () => { try { sessionStorage.setItem(IDLE_NOTE_KEY, '1'); } catch {} };

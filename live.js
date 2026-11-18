// Live mode: Google sign-in + Firestore. Does nothing until FIREBASE_CONFIG is filled in index.html.
//
// Database layout
//   cafe/state        admins only: whole planner (settings, team, schedule) as JSON strings
//   cafe/admins       { emails: [can edit], viewers: [view only] }; only the main owner writes it (see access.js)
//   weeks/<YYYY-MM-DD> admins only: a saved week — schedule text, shifts, pay rows, paid flags
//   cafe/published    the staff text the owner shared; readable by anyone on the team
//   staff/<email>     one per employee: name, week, avail, lock (21-char 0/1 strings).
//                     The employee may read it and change only `avail` + `updatedAt`.
if (window.LIVE) {
  const B = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const { initializeApp } = await import(B + 'firebase-app.js');
  const authMod = await import(B + 'firebase-auth.js');
  const { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } = authMod;
  const A = await import('./access.js');
  const { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, onSnapshot, serverTimestamp } = await import(B + 'firebase-firestore.js');

  const fb = initializeApp(window.FIREBASE_CONFIG), auth = getAuth(fb), db = getFirestore(fb);
  const OWNER = String(window.OWNER_EMAIL || '').trim().toLowerCase();
  const $ = id => document.getElementById(id), app = window.app;
  const all = sel => document.querySelectorAll(sel);
  const show = w => { $('gate').hidden = w !== 'gate'; $('ownerApp').hidden = w !== 'owner'; $('empApp').hidden = w !== 'emp'; };
  const gateMsg = t => { show('gate'); $('gateMsg').textContent = t; };
  const fail = e => { console.error(e); const m = document.querySelector('#ownerApp .sub'); if (m) m.textContent = 'Could not save to the database (' + (e.code || e.message) + '). Check your connection and reload.'; };

  $('signin').onclick = async () => {
    const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    $('gateMsg').textContent = '';
    try { await signInWithPopup(auth, p); }
    catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') signInWithRedirect(auth, p);
      else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') $('gateMsg').textContent = 'Sign-in did not finish (' + e.code + ').';
    }
  };
  all('.signout').forEach(b => b.onclick = () => signOut(auth).then(() => location.reload()));

  let stop = [];
  onAuthStateChanged(auth, async u => {
    stop.forEach(f => f()); stop = [];
    if (!u) { gateMsg(A.idleMessage()); $('signin').hidden = false; all('#gate .signout').forEach(b => b.hidden = true); return; }
    const mail = (u.email || '').toLowerCase();
    all('.who').forEach(x => x.textContent = mail);
    $('signin').hidden = true; all('#gate .signout').forEach(b => b.hidden = false);
    $('gateMsg').textContent = 'Loading…';
    try {
      // owner / edit / view open the full planner (view can't change it); everyone else is staff
      const role = await A.roleOf({ getDoc, doc }, db, mail, OWNER);
      if (role === 'staff') return await employee(mail);
      A.ownerSession(authMod, auth, () => { A.markIdle(); signOut(auth).then(() => location.reload()); });
      await owner(role);
    } catch (e) { console.error(e); gateMsg('Could not load (' + (e.code || e.message) + ').'); }
  });

  async function owner(role) {
    const ref = doc(db, 'cafe', 'state'), snap = await getDoc(ref);
    const d = snap.exists() ? snap.data() : {};
    app.startOwner(d.S ? JSON.parse(d.S) : null, d.shifts ? JSON.parse(d.shifts) : null);
    app.setRole(role);
    show('owner');
    if (role === 'view') {
      // look, don't touch: no save hooks, so nothing is written (the rules would refuse it anyway)
      window.weekStore = { list: async () => (await getDocs(collection(db, 'weeks'))).docs.map(s => s.data()), save: () => Promise.reject(new Error('view only')) };
      stop.push(onSnapshot(collection(db, 'staff'), qs => { const m = {}; qs.forEach(s => m[s.id] = s.data()); app.mergeStaff(m); }, fail));
      return;
    }

    let tS = null, tR = null; const tStaff = {};
    const pushState = () => setDoc(ref, { S: JSON.stringify(app.S()) }, { merge: true }).catch(fail);
    const pushSched = () => app.R() && setDoc(ref, { shifts: JSON.stringify(app.R().shifts) }, { merge: true }).catch(fail);
    window.onSave = () => { clearTimeout(tS); tS = setTimeout(pushState, 600); };
    window.onSaveSched = () => { clearTimeout(tR); tR = setTimeout(pushSched, 600); };
    // withAvail: the owner changed this person's grid, so send it now; otherwise
    // send only name/week/locks so a reply that is still arriving is not overwritten
    window.onStaff = (e, withAvail) => {
      if (!e.email) return;
      const k = e.email, data = { name: e.name, week: app.week(), lock: app.bits(e.lock) };
      if (withAvail) data.avail = app.bits(e.avail);
      clearTimeout(tStaff[k]);
      const go = () => setDoc(doc(db, 'staff', k), data, { merge: true }).catch(fail);
      if (withAvail) go(); else tStaff[k] = setTimeout(go, 500);
    };
    window.onStaffRemove = email => { if (email) deleteDoc(doc(db, 'staff', email)).catch(fail); };
    // saved weeks (schedule + pay) live in weeks/<week start>, admins only
    window.weekStore = {
      list: async () => (await getDocs(collection(db, 'weeks'))).docs.map(s => s.data()),
      save: rec => setDoc(doc(db, 'weeks', rec.week), rec),
    };
    // access list -> cafe/admins (only the main owner may write it)
    window.onAdmins = list => setDoc(doc(db, 'cafe', 'admins'), {
      emails: list.filter(a => a.role === 'edit').map(a => a.email),
      viewers: list.filter(a => a.role === 'view').map(a => a.email),
    }).catch(fail);
    if (!snap.exists()) { pushState(); pushSched(); }

    stop.push(onSnapshot(collection(db, 'staff'), qs => {
      const m = {}; qs.forEach(s => m[s.id] = s.data());
      app.mergeStaff(m);
    }, fail));

    $('pub').onclick = () => setDoc(doc(db, 'cafe', 'published'), { week: app.week(), text: $('txt').value, at: serverTimestamp() })
      .then(() => { $('pub').textContent = 'Shared ✓'; setTimeout(() => $('pub').textContent = 'Share with team', 2500); }, fail);
  }

  async function employee(mail) {
    const ref = doc(db, 'staff', mail);
    await new Promise(res => stop.push(onSnapshot(ref, s => {
      if (!s.exists()) {
        gateMsg(`${mail} isn't on the team list yet. Ask your manager to add this exact email, then reload this page.`);
        return res();
      }
      show('emp');
      app.empLive(s.data(), a => updateDoc(ref, { avail: a, updatedAt: serverTimestamp() })
        .then(() => app.empSaved(true), e => { console.error(e); app.empSaved(false); }));
      res();
    }, e => {
      gateMsg(e.code === 'permission-denied'
        ? `${mail} doesn't have access. Ask your manager to add this exact email.`
        : 'Could not load (' + e.code + ').');
      res();
    })));
    getDoc(doc(db, 'cafe', 'published')).then(s => { if (s.exists()) app.empSchedule(s.data()); }).catch(() => {});
  }
}

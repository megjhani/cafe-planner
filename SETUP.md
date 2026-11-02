# Cafe Shift Planner: live setup

The planner runs on a free website. You sign in with Google and see everything. Each employee signs in
with their Google account and sees only their own availability grid; locked cells can't be changed.
Their answers show up in your view within seconds.

It takes about 15 minutes, all in a web browser. Everything here is free (Firebase "Spark" plan, GitHub Pages).

## 1. Firebase (login + database)

1. Go to https://console.firebase.google.com and sign in with the Google account you'll run the planner from.
2. **Create a project** and call it something like `cafe-planner`. Google Analytics can be turned off.
3. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**
4. **Build → Firestore Database → Create database.** Pick a location near you and choose **production mode**.
5. Open the **Rules** tab. Delete what's there and paste in all of `firestore.rules`.
   Change `owner@example.com` to your Google email, then press **Publish**.
6. Click the gear icon, then **Project settings → Your apps → Web (`</>`)**. Give it any nickname and press **Register app**.
   Leave "Firebase Hosting" unticked. You'll see a `firebaseConfig = { ... }` block.

## 2. Put your details in `index.html`

Open `index.html` in Notepad. Near the top, fill in:

```js
window.FIREBASE_CONFIG = { apiKey: "AIza...", authDomain: "cafe-planner-xxxx.firebaseapp.com", projectId: "cafe-planner-xxxx", appId: "1:...:web:..." };
window.OWNER_EMAIL = "you@gmail.com";
```

Copy the four values from the Firebase block. The `apiKey` isn't a secret: anyone can see it, and the database
rules are what protect your data.

## 3. GitHub Pages (the website)

1. Create a free account at https://github.com, then click **New repository**. Name it `cafe-planner`, make it **Public**, and press **Create**.
2. Click **uploading an existing file**, drag in `index.html` and `live.js`, and press **Commit changes**.
   Only the app code goes on GitHub. Your team and schedule stay in Firebase.
3. Open the repository's **Settings → Pages**. Under *Branch*, choose `main` and `/ (root)`, then **Save**.
   About a minute later the site is at `https://YOUR-GITHUB-NAME.github.io/cafe-planner/`.
4. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** → `YOUR-GITHUB-NAME.github.io`.

## 4. Use it

1. Open the site and **Sign in with Google** using your owner email. You'll see the full planner.
2. In *Team & preferences*, enter each person's **Google email** under their name.
3. Press **Lock cells** under a person and tap the cells that are yours to decide (for example Masha's Tue evening), then press **Done locking**.
4. Press **Copy app link** and text it to them. It's the same link for everyone. Each person signs in and sees only their own grid.
5. When the replies are in, press **Build schedule**, adjust the bars, then press **Share with team**.
   Staff then see the week's schedule below their grid.

## Good to know

- Each employee has to sign in with the **exact email** you typed for them. Someone without a Google account can create one
  for free with any email address at https://accounts.google.com/signup ("use my current email address instead").
- If someone leaves, press **×** next to their name. Their access stops right away.
- To update the app later, upload the new `index.html` / `live.js` to the same GitHub repository. Your data stays as it is.
- If you leave `apiKey` empty, the page runs offline as before: everything is saved in your browser, and the invite-code flow is used.

---
name: nativewright-login-bootstrap
description: Use when a site requires manual human login for the first time in the NativeWright Chrome profile, or when a previously logged-in session has expired — specifically bootstrapping Google / Microsoft / GitHub / SaaS sessions that automation cannot complete on its own. Establishes persistent login that future NativeWright runs will reuse.
---

# NativeWright Login Bootstrap

A one-off ritual that establishes a persistent logged-in session in the NativeWright Chrome profile. After this runs once per site, every future NativeWright run can drive the site as an authenticated user without re-entering credentials.

## When to use

- The target site returns a login page when NativeWright navigates there.
- A previously working logged-in flow suddenly bounces through login (session expired — Google typically re-auths every ~14 days).
- You are setting up a fresh machine and need to seed the profile with accounts.

## When NOT to use

- The site accepts API tokens or service accounts — use those instead.
- The site supports SSO and your profile already has the SSO provider logged in — just navigate; SSO should auto-complete.

## The procedure

This requires the human partner at the keyboard. You cannot log in on their behalf. The goal: open the login page in the visible Chrome window, let the human log in, confirm it worked, stop the daemon cleanly. The profile now holds the cookies.

### 1. Confirm no Chrome is already using the profile

The profile is locked exclusively. Check:

```bash
nativewright status
# Windows: tasklist | findstr chrome
# Unix:    pgrep -fl chrome
```

If `status` shows `running: true`, reuse it — skip to step 3. If a regular Chrome window is open against the same profile directory, close it first.

### 2. Start the daemon in a background task

```
Bash(command='nativewright start', run_in_background=true)
```

```bash
nativewright wait-ready --timeout=30000
```

### 3. Open the login URL in a visible window

```bash
nativewright goto "https://accounts.google.com/"
# or https://github.com/login, https://login.microsoftonline.com/, etc.
```

The Chrome window is real and visible on the human partner's desktop.

### 4. Hand off to the human

Explicitly tell your human partner:

> "A Chrome window is open at the login page. Please log in manually in that window. When you're done, reply 'done' (or the equivalent) so I can verify the session persisted."

Do not proceed until they confirm.

### 5. Verify the login took

```bash
nativewright url                     # should no longer be the login page
nativewright title                   # should be the post-login landing
nativewright save-artifact login-ok  # capture evidence
```

For Google specifically, a good cross-check is to navigate to a service that requires auth:

```bash
nativewright goto "https://myaccount.google.com/"
nativewright text "h1"
```

If it shows a personalized account page, login succeeded. Cite the artifact path.

### 6. Stop the daemon — MANDATORY

<HARD-GATE>
After the login is verified, you MUST call `stop` before ending the task. Not optional. The whole point of this skill is to persist the session — and the session is only guaranteed persisted once `stop` has flushed cookies/tokens to disk and released the profile lock.
</HARD-GATE>

```bash
nativewright stop
```

Why this matters specifically for login-bootstrap: the cookies Google / Microsoft / SaaS just issued are held in Chrome's in-memory state. Chrome flushes them to disk periodically, but graceful `stop` is the only way to guarantee they land before process exit. If the daemon is killed without `stop` (timeout, Ctrl+C, taskkill), the new login may not survive to the next session — and you'll have to repeat this entire bootstrap.

The next `nativewright start` will open the same profile with all cookies intact — only if you stopped cleanly.

## Critical rules

- **Never open the profile in a normal Chrome window.** Chrome holds an exclusive lock on a profile directory; opening it a second time (even from a stock Chrome launcher) will corrupt the profile or fail loudly. The NativeWright daemon IS the owner while running; regular Chrome must use a different profile.
- **Never do the login automatically.** Scripting credential entry trips anti-automation heuristics on Google and Microsoft hard. The whole point of Patchright's stealth is that the human does the login; the daemon just holds the resulting session.
- **Never share the profile directory.** It contains personal session tokens. Keep it local.
- **Session lifetime varies**: Google ~14 days, Microsoft ~14-90 days, GitHub months, most SaaS days-to-months. When automation starts bouncing to a login page, rerun this skill.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `start` fails with profile-lock error | something else holds the profile | close all Chrome windows, terminate any zombie processes, retry |
| Login page shows "This browser may not be secure" | Google's anti-automation caught something | Patchright's stealth usually bypasses this; if not, the user may need to complete an extra step in the visible window |
| After login, next day it's logged out again | device binding not persisted | sometimes Google reissues a device token on second visit; repeat the bootstrap once more |
| Chrome window never appears | daemon crashed on launch; OR headless mode is on | check `$NATIVEWRIGHT_HOME/logs/daemon.log`; ensure `NATIVEWRIGHT_HEADLESS` is NOT set |

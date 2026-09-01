/**
 * Account pages: email verification and password reset.
 *
 * These close two holes that were invisible from the outside because the APIs
 * behind them were built, tested and completely unreachable.
 *
 * EMAIL VERIFICATION was the more serious of the two. `publishBlockers`
 * refuses to publish a listing whose owner has not confirmed their address —
 * deliberately, because verifying an address costs a bulk poster time and
 * that is the whole point of the check. But nothing in the product could send
 * or redeem a code, so the refusal was permanent: an owner could write a
 * listing, add photos, confirm the description, and be told to verify an
 * address with nowhere to go and do it. No listing could be published by
 * anyone.
 *
 * PASSWORD RESET was the other: lock yourself out and there was no way back
 * in, on a site with no support desk.
 *
 * A note on the shape of the reset flow. It is two pages, not one, because
 * the code arrives in a different place from the browser tab that asked for
 * it — often on a different device. A single page holding a pending state
 * across that gap is a page people close.
 */
import { html } from './html.js';
import { page, csrfField, type Flash, type Viewer } from './layout.js';
import { icon, iconSprite } from './icons.js';

/**
 * The code entry field, shared by both flows.
 *
 * `inputmode="numeric"` and `autocomplete="one-time-code"` are the two
 * attributes that matter on a phone: the first brings up the number pad, the
 * second lets iOS and Android offer the code straight from the notification so
 * it never has to be memorised and retyped between apps.
 */
function codeField(): ReturnType<typeof html> {
  return html`
<div class="field">
  <label for="code">Six-digit code</label>
  <input id="code" type="text" name="code" required inputmode="numeric" autocomplete="one-time-code"
         pattern="[0-9]{6}" maxlength="6" placeholder="123456"
         style="font-size:22px;letter-spacing:.32em;text-align:center;font-family:ui-monospace,monospace">
</div>`;
}

// ── email verification ──────────────────────────────────────────────────────

export function verifyEmailPage(opts: Flash & {
  viewer: Viewer;
  email: string;
  verified: boolean;
  /** True once a code has been sent in this session, so the form is shown. */
  sent: boolean;
}): string {
  return page(
    {
      title: 'Confirm your email',
      viewer: opts.viewer,
      path: '/account/email',
      notice: opts.notice,
      error: opts.error,
    },
    html`
${iconSprite()}
<div class="wrap" style="max-width:440px;padding:44px 20px 60px">
  ${opts.verified
    ? html`
      <h1>Email confirmed</h1>
      <p class="notice" style="display:flex;align-items:center;gap:8px">
        ${icon('check')} <span><strong>${opts.email}</strong> is confirmed.</span>
      </p>
      <p class="small muted">
        Nothing else to do here. Your listings can be published.
      </p>
      <p style="margin-top:22px"><a class="btn" href="/dashboard/listings">My listings</a></p>`
    : html`
      <h1>Confirm your email</h1>
      <p class="muted" style="margin-top:-4px">
        We send a six-digit code to <strong>${opts.email}</strong>. It lasts ten
        minutes.
      </p>
      <p class="small muted">
        This is why: a listing cannot be published until the address behind it
        is real. It costs someone posting one listing a minute, and it costs
        someone posting a thousand a great deal more.
      </p>

      <form method="post" action="/account/email/send" style="margin-top:20px">
        ${csrfField(opts.viewer)}
        <button class="btn${opts.sent ? '' : ' btn-primary'}" type="submit">
          ${opts.sent ? 'Send another code' : 'Send me a code'}
        </button>
      </form>

      ${/* The entry form is always present, not revealed only after sending.
            A code from ten minutes ago in another tab is still valid, and a
            page that hides the box until you press the button again would
            make the owner request a second code they do not need. */ null}
      <form method="post" action="/account/email/confirm" class="stack"
            style="margin-top:24px;border-top:1px solid var(--line);padding-top:20px">
        ${csrfField(opts.viewer)}
        ${codeField()}
        <button class="btn btn-primary" type="submit" style="width:100%">Confirm</button>
      </form>

      <p class="small muted" style="margin-top:16px">
        Not seeing it? Check the spam folder, then send another code. Codes are
        single use, and asking for a new one retires the old.
      </p>`}
</div>`,
  );
}

// ── password reset ──────────────────────────────────────────────────────────

export function forgotPasswordPage(opts: Flash & { email?: string | null }): string {
  return page(
    { title: 'Reset your password', viewer: null, path: '/forgot-password',
      notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:400px;padding:52px 20px">
  <h1>Reset your password</h1>
  <p class="muted" style="margin-top:-4px">
    Give us the address on the account and we will send a six-digit code.
  </p>
  <form method="post" action="/forgot-password" class="stack" style="margin-top:18px">
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email"
             value="${opts.email ?? ''}">
    </div>
    <button class="btn btn-primary" type="submit" style="width:100%">Send the code</button>
  </form>
  <p class="small muted" style="margin-top:18px">
    Remembered it? <a href="/signin">Sign in</a>.
    Already have a code? <a href="/reset-password">Enter it</a>.
  </p>
</div>`,
  );
}

/**
 * Step two.
 *
 * The email is carried in the URL and shown in a field the person can correct.
 * That is not a secret — they typed it on the previous page — and having it
 * prefilled is what makes this survive being opened on the phone that received
 * the code rather than the laptop that asked for it.
 */
export function resetPasswordPage(opts: Flash & { email?: string | null }): string {
  return page(
    { title: 'Choose a new password', viewer: null, path: '/reset-password',
      notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:400px;padding:52px 20px">
  <h1>Choose a new password</h1>
  <form method="post" action="/reset-password" class="stack" style="margin-top:18px">
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email"
             value="${opts.email ?? ''}">
    </div>
    ${codeField()}
    <div class="field">
      <label for="pw">New password</label>
      <input id="pw" type="password" name="newPassword" required minlength="12"
             autocomplete="new-password">
      <p class="small muted" style="margin:6px 0 0">
        At least 12 characters. Length is what makes a password strong; a
        phrase you will remember beats a short one full of punctuation.
      </p>
    </div>
    <button class="btn btn-primary" type="submit" style="width:100%">
      Set the new password
    </button>
  </form>
  ${/* Said before it happens, not after. Being signed out everywhere is
        surprising unless you were told, and it is the entire point when the
        reset was prompted by someone else being in the account. */ null}
  <p class="small muted" style="margin-top:16px">
    This signs you out everywhere else. If someone else was in your account,
    that is what removes them.
  </p>
  <p class="small muted">
    No code yet? <a href="/forgot-password">Ask for one</a>.
  </p>
</div>`,
  );
}

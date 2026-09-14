'use strict';

// Same-origin sign-in completion handoff.
//
// Azure AD's OIDC callback (response_mode=form_post) delivers a genuine
// cross-site, top-level POST to /auth/manager/callback. Per SameSite=Strict
// semantics, a cookie set while handling that POST is withheld from the
// *entire* redirect chain the browser considers still rooted in that
// cross-site navigation -- including a same-origin 302 issued by our own
// server in the same response cycle. Ending the cross-site-rooted
// navigation here with a same-origin 200 document, then letting THIS
// already-loaded document initiate a brand-new top-level navigation
// (via this script, or the visible link as a no-JS fallback), resets the
// "site for cookies" for that follow-up request so the session cookie is
// sent normally.
(function continueManagerSignIn() {
  var currentScript = document.currentScript;
  var continueHref = currentScript && currentScript.dataset
    ? currentScript.dataset.continueHref
    : null;
  if (!continueHref) {
    return;
  }
  try {
    window.location.replace(continueHref);
  } catch (_err) {
    // Ignore; the visible "Continue" link on the page is the safe fallback.
  }
})();

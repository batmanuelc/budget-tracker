/* GitHub Pages -> Google OAuth -> Apps Script API -> private Google Sheet. */
(function () {
  'use strict';
  const config = window.POCKETBOOK_CONFIG || {};
  const scope = 'https://www.googleapis.com/auth/spreadsheets';
  const allowed = new Set(['getData', 'saveRecord', 'deleteRecord', 'payBill', 'saveCurrency']);
  let token = '', expiresAt = 0, client, loading, connecting = false, generation = 0;
  const api = window.PocketbookApi = {
    configured: Boolean(config.googleClientId && config.deploymentId),
    onAuthRequired: null,
    prepare: loadIdentity, connect, disconnect, call
  };

  function forget() {
    token = '';
    expiresAt = 0;
    if (api.onAuthRequired) api.onAuthRequired();
  }

  function loadIdentity() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) resolve();
        else reject(new Error('Google sign-in could not initialize. Reload and try again.'));
      };
      script.onerror = () => { loading = null; script.remove(); reject(new Error('Unable to load Google sign-in. Check your connection and try again.')); };
      document.head.appendChild(script);
    });
    return loading;
  }

  async function connect() {
    if (!api.configured) throw new Error('Set googleClientId and deploymentId in config.js before connecting.');
    if (connecting) throw new Error('Google sign-in is already open.');
    connecting = true;
    const attempt = generation;
    try {
      await loadIdentity();
      return await new Promise((resolve, reject) => {
        client = google.accounts.oauth2.initTokenClient({
          client_id: config.googleClientId,
          scope,
          callback(response) {
            if (attempt !== generation) { reject(new Error('Sign-in cancelled.')); return; }
            if (response.error || !response.access_token) { reject(new Error(response.error_description || response.error || 'Google did not return an access token.')); return; }
            if (!google.accounts.oauth2.hasGrantedAllScopes(response, scope)) { reject(new Error('Allow Google Sheets access to connect your ledger.')); return; }
            token = response.access_token;
            expiresAt = Date.now() + Math.max(0, Number(response.expires_in || 3600) - 60) * 1000;
            resolve();
          },
          error_callback(error) { reject(new Error(error.type === 'popup_closed' ? 'Sign-in was closed. Click Connect Google to try again.' : 'Google sign-in could not open. Allow popups and try again.')); }
        });
        // Always initiated by the Connect button, never by automatic page loading.
        client.requestAccessToken({ prompt: 'select_account' });
      });
    } finally { connecting = false; }
  }

  function disconnect() {
    generation++;
    forget();
    // Tokens stay in memory only. Disconnect clears this page's session;
    // it does not sign out of Google or revoke access for other Google apps.
  }

  async function call(method, ...parameters) {
    if (!allowed.has(method)) throw new Error('Unsupported backend operation.');
    if (!token || Date.now() >= expiresAt) {
      forget();
      throw new Error('Your session has expired. Connect Google again.');
    }
    const session = generation;
    let response;
    try {
      response = await fetch('https://script.googleapis.com/v1/scripts/' + encodeURIComponent(config.deploymentId) + ':run', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ function: method, parameters, devMode: false }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
    } catch (_) {
      throw new Error('Connection interrupted. Reconnect and check your ledger before retrying a save; it may already have completed.');
    }
    if (session !== generation) throw new Error('Session changed. Connect again to load your ledger.');
    if (response.status === 401) {
      forget();
      throw new Error('Your Google session has expired. Connect Google again.');
    }
    let result;
    try { result = await response.json(); } catch (_) { throw new Error('Google returned an unreadable response. Check your deployment configuration.'); }
    if (!response.ok || result.error) {
      const detail = result.error && result.error.details && result.error.details.find(d => d.errorMessage);
      const message = (detail && detail.errorMessage) || (result.error && result.error.message) || ('Google API error ' + response.status);
      throw new Error(message + (response.status === 403 ? ' Check API Executable access, the enabled Apps Script API, and that the OAuth client and script use the same Cloud project.' : ''));
    }
    if (!result.done || !result.response || !result.response.result) throw new Error('Google did not return a completed ledger response. Check your ledger before retrying.');
    return result.response.result;
  }
})();

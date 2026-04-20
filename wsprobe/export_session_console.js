// Paste into DevTools Console on https://my.wealthsimple.com (logged in).
// Tries: document cookie, Cookie Store, __NEXT_DATA__, localStorage/sessionStorage, window globals; optional paste; then hints for wsprobe --cookies-from-browser.
// Regenerate one-liner: npx terser wsprobe/export_session_console.js -c -m -o wsprobe/export_session_console.min.js
(function () {
  function bundleFromObject(obj, depth) {
    if (depth > 8 || !obj || typeof obj !== "object") return null;
    if (typeof obj.access_token === "string" && obj.access_token.length > 20) {
      const o = { access_token: obj.access_token };
      if (typeof obj.refresh_token === "string") o.refresh_token = obj.refresh_token;
      if (typeof obj.client_id === "string") o.client_id = obj.client_id;
      return o;
    }
    if (Array.isArray(obj)) {
      for (const x of obj) {
        const b = bundleFromObject(x, depth + 1);
        if (b) return b;
      }
      return null;
    }
    for (const k of Object.keys(obj)) {
      try {
        const b = bundleFromObject(obj[k], depth + 1);
        if (b) return b;
      } catch (_) {}
    }
    return null;
  }

  function tryDocumentCookie() {
    const m = document.cookie.match(/(?:^|;\s*)_oauth2_access_v2=([^;]+)/);
    if (!m) return null;
    try {
      const raw = decodeURIComponent(m[1].trim());
      return bundleFromObject(JSON.parse(raw), 0);
    } catch (_) {
      return null;
    }
  }

  function tryStorage() {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k) continue;
        const v = store.getItem(k);
        if (!v || v.length > 2e6) continue;
        try {
          const b = bundleFromObject(JSON.parse(v), 0);
          if (b) return b;
        } catch (_) {}
        try {
          const b = bundleFromObject(JSON.parse(decodeURIComponent(v)), 0);
          if (b) return b;
        } catch (_) {}
      }
    }
    return null;
  }

  function tryNextData() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el || !el.textContent) return null;
    try {
      return bundleFromObject(JSON.parse(el.textContent), 0);
    } catch (_) {
      return null;
    }
  }

  function tryWindowGlobals() {
    const keys = Object.keys(window).filter((k) =>
      /oauth|apollo|relay|__.*(ws|WS|auth|Auth|token|Token|store|Store)/i.test(k),
    );
    for (const k of keys) {
      try {
        const b = bundleFromObject(window[k], 0);
        if (b) return b;
      } catch (_) {}
    }
    return null;
  }

  function finish(bundle) {
    const out = JSON.stringify(bundle, null, 2);
    console.log(out);
    if (typeof copy === "function") {
      copy(out);
      console.log("Copied. Save as file: ~/.config/wsprobe/session.json");
    } else {
      console.log("Save the JSON above to: ~/.config/wsprobe/session.json");
    }
  }

  function fail() {
    console.warn(
      "%cStill stuck?",
      "font-weight:bold;font-size:14px",
      "\nQuit your browser, then run:  wsprobe --cookies-from-browser chrome ping",
    );
  }

  const sync =
    tryDocumentCookie() ||
    tryStorage() ||
    tryNextData() ||
    tryWindowGlobals();

  if (sync) {
    finish(sync);
    return;
  }

  void (async function () {
    if (typeof cookieStore !== "undefined") {
      try {
        const c = await cookieStore.get({
          name: "_oauth2_access_v2",
          url: "https://my.wealthsimple.com/",
        });
        if (c && typeof c.value === "string" && c.value.length > 0) {
          const raw = decodeURIComponent(c.value.trim());
          const ob = bundleFromObject(JSON.parse(raw), 0);
          if (ob) {
            finish(ob);
            return;
          }
        }
      } catch (_) {}
    }

    let p = null;
    if (typeof prompt === "function") {
      p = prompt(
        "Paste the Value of cookie _oauth2_access_v2 (Application → Cookies → my.wealthsimple.com). Or Cancel.",
      );
    }
    if (p && String(p).trim()) {
      try {
        const t = String(p).trim();
        const data = JSON.parse(t.startsWith("{") ? t : decodeURIComponent(t));
        const ob = bundleFromObject(data, 0);
        if (ob) {
          finish(ob);
          return;
        }
      } catch (e) {
        console.error(e);
      }
    }
    fail();
  })();
})();

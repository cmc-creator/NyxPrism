// Import from Google Drive / Dropbox into any tool, and save results to Google Drive.
// Turned on by filling in the keys in /config.js (see CLOUD_SETUP.md); hidden otherwise.
(function () {
  var cfg = window.NYX_CLOUD || {};
  var hasDrive = Boolean(cfg.googleClientId && cfg.googleApiKey);
  var hasDropbox = Boolean(cfg.dropboxAppKey);
  if (!hasDrive && !hasDropbox) return;

  function loadScript(src, attrs) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src; s.async = true;
      Object.keys(attrs || {}).forEach(function (k) { s.setAttribute(k, attrs[k]); });
      s.onload = resolve; s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function notify(msg, type) { if (typeof window.toast === 'function') window.toast(msg, type || 'success'); }

  // Hand a picked file to a tool exactly as if it had been dropped on its drop zone.
  function deliver(dropZone, file) {
    var dt = new DataTransfer(); dt.items.add(file);
    dropZone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }
  function acceptFor(dropZone) {
    var input = dropZone.querySelector('input[type=file]') || dropZone.parentElement.querySelector('input[type=file]');
    return /image/.test((input && input.accept) || '') ? 'image' : 'pdf';
  }

  // ── Google (Drive picker + Drive upload) ──
  var googleToken = null;
  function googleAuth(scope) {
    return loadScript('https://accounts.google.com/gsi/client').then(function () {
      return new Promise(function (resolve, reject) {
        var client = window.google.accounts.oauth2.initTokenClient({
          client_id: cfg.googleClientId, scope: scope,
          callback: function (res) { if (res.error) reject(new Error(res.error)); else { googleToken = res.access_token; resolve(googleToken); } },
        });
        client.requestAccessToken({ prompt: googleToken ? '' : 'consent' });
      });
    });
  }
  function pickFromDrive(dropZone) {
    var kind = acceptFor(dropZone);
    Promise.all([loadScript('https://apis.google.com/js/api.js'), googleAuth('https://www.googleapis.com/auth/drive.readonly')])
      .then(function () { return new Promise(function (r) { window.gapi.load('picker', r); }); })
      .then(function () {
        var p = window.google.picker;
        var view = new p.DocsView(p.ViewId.DOCS).setMimeTypes(kind === 'image' ? 'image/png,image/jpeg,image/webp' : 'application/pdf');
        new p.PickerBuilder().addView(view).setOAuthToken(googleToken).setDeveloperKey(cfg.googleApiKey)
          .setCallback(function (data) {
            if (data.action !== p.Action.PICKED) return;
            var doc = data.docs[0];
            notify('Downloading ' + doc.name + ' from Google Drive…', 'info');
            fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(doc.id) + '?alt=media', { headers: { Authorization: 'Bearer ' + googleToken } })
              .then(function (r) { if (!r.ok) throw new Error('Google Drive download failed (' + r.status + ')'); return r.blob(); })
              .then(function (blob) { deliver(dropZone, new File([blob], doc.name, { type: doc.mimeType || blob.type })); })
              .catch(function (err) { notify(err.message, 'error'); });
          }).build().setVisible(true);
      })
      .catch(function (err) { notify('Google Drive: ' + err.message, 'error'); });
  }
  function saveToDrive(blob, name) {
    return googleAuth('https://www.googleapis.com/auth/drive.file').then(function (token) {
      var meta = new Blob([JSON.stringify({ name: name })], { type: 'application/json' });
      var form = new FormData(); form.append('metadata', meta); form.append('file', blob, name);
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    }).then(function (r) { if (!r.ok) throw new Error('upload failed (' + r.status + ')'); notify('Saved ' + name + ' to Google Drive'); })
      .catch(function (err) { notify('Google Drive: ' + err.message, 'error'); });
  }

  // ── Dropbox (Chooser) ──
  function pickFromDropbox(dropZone) {
    var kind = acceptFor(dropZone);
    loadScript('https://www.dropbox.com/static/api/2/dropins.js', { id: 'dropboxjs', 'data-app-key': cfg.dropboxAppKey }).then(function () {
      window.Dropbox.choose({
        linkType: 'direct', multiselect: false,
        extensions: kind === 'image' ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.pdf'],
        success: function (files) {
          var f = files[0]; notify('Downloading ' + f.name + ' from Dropbox…', 'info');
          fetch(f.link).then(function (r) { if (!r.ok) throw new Error('Dropbox download failed (' + r.status + ')'); return r.blob(); })
            .then(function (blob) { deliver(dropZone, new File([blob], f.name, { type: blob.type || (kind === 'pdf' ? 'application/pdf' : '') })); })
            .catch(function (err) { notify(err.message, 'error'); });
        },
      });
    }).catch(function (err) { notify('Dropbox: ' + err.message, 'error'); });
  }

  // ── Add the import row under every drop zone ──
  document.querySelectorAll('.drop-zone').forEach(function (zone) {
    var row = document.createElement('div');
    row.className = 'cloud-import';
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.5rem 0 .75rem;font-size:.8rem;color:var(--text3)';
    row.appendChild(document.createTextNode('Or import from:'));
    function button(label, fn) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost'; b.textContent = label;
      b.style.cssText = 'font-size:.78rem;padding:.3rem .6rem';
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(zone); });
      row.appendChild(b);
    }
    if (hasDrive) button('Google Drive', pickFromDrive);
    if (hasDropbox) button('Dropbox', pickFromDropbox);
    zone.after(row);
  });

  // ── Offer "Save to Google Drive" after any download ──
  if (hasDrive) {
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;right:1.25rem;bottom:5.5rem;z-index:800;display:none';
    var save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-secondary'; save.textContent = 'Save to Google Drive';
    bar.appendChild(save); document.body.appendChild(bar);
    var last = null, timer = null;
    save.addEventListener('click', function () { if (last) { bar.style.display = 'none'; saveToDrive(last.blob, last.name); } });
    document.addEventListener('nyx:download', function (e) {
      last = { blob: e.detail.blob, name: e.detail.filename }; bar.style.display = 'block';
      clearTimeout(timer); timer = setTimeout(function () { bar.style.display = 'none'; }, 20000);
    });
  }
  window.__nyxCloud = { deliver: deliver, pickFromDrive: pickFromDrive, pickFromDropbox: pickFromDropbox, saveToDrive: saveToDrive };
})();

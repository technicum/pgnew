// "Import from Google Drive" for Leads > Import leads. Opens Google's own
// Picker, downloads the chosen spreadsheet's bytes straight into the
// browser, drops them into the form's normal file input and submits it --
// so the server only ever sees an ordinary file upload (see
// lib/leadImport.js). No Drive credentials ever reach this server.
(function () {
  var button = document.getElementById('crmImportFromDrive');
  var fileInput = document.getElementById('crmImportFile');
  var form = document.getElementById('crmImportForm');
  if (!button || !fileInput || !form) return;

  var clientId = button.dataset.googleClientId;
  var apiKey = button.dataset.googleApiKey;
  // drive.file only grants access to files the user picks, and Google only
  // honours that grant when the Picker is given the Cloud project number --
  // which is the numeric prefix of the OAuth client ID.
  var appId = String(clientId || '').split('-')[0];
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var PICKABLE_MIMES = [
    SHEET_MIME,
    XLSX_MIME,
    'application/vnd.ms-excel',
    'text/csv',
  ].join(',');

  var idleLabel = button.textContent;
  var tokenClient = null;
  var scriptsReady = null;

  function setBusy(label) {
    button.disabled = !!label;
    button.textContent = label || idleLabel;
  }

  function fail(message) {
    setBusy('');
    window.alert(message);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadGoogle() {
    if (!scriptsReady) {
      scriptsReady = Promise.all([
        loadScript('https://apis.google.com/js/api.js'),
        loadScript('https://accounts.google.com/gsi/client'),
      ]).then(function () {
        return new Promise(function (resolve) { window.gapi.load('picker', resolve); });
      });
      scriptsReady.catch(function () { scriptsReady = null; });
    }
    return scriptsReady;
  }

  function requestToken() {
    return new Promise(function (resolve, reject) {
      tokenClient = tokenClient || window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: function () {},
      });
      tokenClient.callback = function (resp) {
        if (resp.error || !resp.access_token) reject(new Error(resp.error || 'No access token'));
        else resolve(resp.access_token);
      };
      tokenClient.error_callback = function (err) {
        reject(new Error((err && err.type) || 'Google sign-in was closed'));
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  function pickFile(token) {
    return new Promise(function (resolve) {
      var view = new window.google.picker.DocsView().setMimeTypes(PICKABLE_MIMES).setIncludeFolders(true);
      var picker = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .setCallback(function (data) {
          var action = data[window.google.picker.Response.ACTION];
          if (action === window.google.picker.Action.PICKED) {
            resolve(data[window.google.picker.Response.DOCUMENTS][0]);
          } else if (action === window.google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  // Native Google Sheets have no bytes of their own, so they have to be
  // exported (as .xlsx); real .xlsx/.xls/.csv files are downloaded as-is.
  function download(doc, token) {
    var id = encodeURIComponent(doc.id);
    var isSheet = doc.mimeType === SHEET_MIME;
    var url = 'https://www.googleapis.com/drive/v3/files/' + id +
      (isSheet ? '/export?mimeType=' + encodeURIComponent(XLSX_MIME) : '?alt=media');
    return fetch(url, { headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
      if (!res.ok) throw new Error('Google Drive returned ' + res.status);
      return res.blob();
    }).then(function (blob) {
      var name = doc.name || 'leads';
      if (isSheet && !/\.xlsx$/i.test(name)) name += '.xlsx';
      return new File([blob], name, { type: isSheet ? XLSX_MIME : (doc.mimeType || blob.type) });
    });
  }

  button.addEventListener('click', function () {
    if (!clientId || !apiKey) {
      window.alert(
        "Google Drive import isn't set up on this server yet.\n\n" +
        'Ask the site admin to set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_API_KEY ' +
        '(see .env.example), then restart the app. Meanwhile you can upload a file from your computer.'
      );
      return;
    }
    setBusy('Connecting to Google…');
    loadGoogle()
      .then(requestToken)
      .then(function (token) {
        return pickFile(token).then(function (doc) {
          if (!doc) { setBusy(''); return null; }
          setBusy('Downloading…');
          return download(doc, token);
        });
      })
      .then(function (file) {
        if (!file) return;
        var dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        setBusy('Importing…');
        form.requestSubmit();
      })
      .catch(function (err) {
        fail('Could not import from Google Drive: ' + err.message);
      });
  });
})();

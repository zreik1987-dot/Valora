// Valora site interactions: photo gallery switching and confirm dialogs.
// No inline handlers (the Content Security Policy blocks them).

document.addEventListener('DOMContentLoaded', function () {
  // Listing photo gallery: click a thumbnail to switch the main photo.
  var main = document.getElementById('main-photo');
  var thumbs = document.querySelectorAll('.gallery-thumb');
  if (main && thumbs.length) {
    thumbs.forEach(function (thumb) {
      thumb.addEventListener('click', function () {
        main.src = thumb.dataset.full || thumb.src;
        thumbs.forEach(function (t) {
          t.classList.remove('active');
        });
        thumb.classList.add('active');
      });
    });
  }

  // Destructive actions: <form data-confirm="Are you sure?">
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) {
        e.preventDefault();
      }
    });
  });

  // PWA: register the service worker for the installable app experience.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {
        // Offline support is a bonus; the site works fine without it.
      });
    });
  }

  // PWA: show an "Install app" button when the browser offers installation.
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallButton();
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    var btn = document.getElementById('pwa-install-btn');
    if (btn) btn.remove();
  });

  function showInstallButton() {
    if (document.getElementById('pwa-install-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'pwa-install-btn';
    btn.type = 'button';
    btn.className = 'btn pwa-install';
    btn.textContent = 'Install app';
    btn.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        btn.remove();
      }).catch(function () {});
    });
    document.body.appendChild(btn);
  }
});

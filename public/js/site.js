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
});

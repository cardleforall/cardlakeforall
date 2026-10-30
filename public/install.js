// Offers to install Cardlake as an app. Chrome, Edge and Samsung Internet hand
// us an install prompt (beforeinstallprompt); browsers on iPhone and iPad have
// none, so there we show the Add to Home Screen steps instead. Elements marked
// data-cardle-install stay hidden everywhere else, and inside the installed app.
(function () {
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return;
  // iPadOS reports itself as a Mac, so tell it apart by its touch screen.
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var deferredPrompt = null;

  function containers() { return document.querySelectorAll('[data-cardle-install]'); }
  function setVisible(visible) {
    containers().forEach(function (el) { el.hidden = !visible; });
  }
  // Every browser on iOS can add Cardlake to the home screen (iOS 16.4 and
  // later), but Share sits in a different place in each, so name the right one.
  function iosHowTo() {
    var ua = navigator.userAgent;
    var addToHome = ', then <strong>Add to Home Screen</strong>';
    if (/CriOS/.test(ua)) return 'tap <strong>Share</strong> next to the address bar' + addToHome;
    if (/FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua)) {
      return 'open the browser menu, tap <strong>Share</strong>' + addToHome +
        ' (or open ' + location.host + ' in Safari)';
    }
    return 'tap <strong>Share</strong> in Safari' + addToHome;
  }

  // There is no install prompt to open on iOS, so the button points at the
  // steps instead. They may already be showing (after an earlier tap), so
  // flash them each time: otherwise the tap looks like it did nothing.
  // A button with no room for the steps beside it (the vault header's icon)
  // names the page that has them in data-cardle-install-show.
  function showIosSteps(button) {
    var page = button.getAttribute('data-cardle-install-show');
    if (page && typeof window.showPage === 'function') window.showPage(page);
    var steps = Array.prototype.filter.call(document.querySelectorAll('[data-cardle-install-ios]'), function (el) {
      el.hidden = false;
      return el.offsetParent !== null;
    });
    if (!steps[0]) return;
    steps[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    steps[0].classList.remove('cardle-install-flash');
    void steps[0].offsetWidth; // restart the animation on a repeat tap
    steps[0].classList.add('cardle-install-flash');
  }

  function onClick(event) {
    var button = event.target.closest('[data-cardle-install-button]');
    if (!button) return;
    event.preventDefault();
    if (deferredPrompt) {
      var prompt = deferredPrompt;
      // A prompt can only be shown once; Chrome fires a new event if the
      // person dismisses it and stays eligible.
      deferredPrompt = null;
      prompt.prompt();
      prompt.userChoice.then(function (choice) {
        if (choice.outcome === 'accepted') setVisible(false);
      });
    } else if (ios) {
      showIosSteps(button);
    }
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    setVisible(true);
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    setVisible(false);
  });
  document.addEventListener('click', onClick);
  if (ios) {
    var showOffer = function () {
      var how = iosHowTo();
      document.querySelectorAll('[data-cardle-install-ios-how]').forEach(function (el) { el.innerHTML = how; });
      setVisible(true);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showOffer);
    else showOffer();
  }
})();

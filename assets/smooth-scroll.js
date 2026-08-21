(function () {
  if (typeof window.Lenis !== 'function') return;

  var LOCK_CLASSES = [
    'overflow-hidden',
    'overflow-hidden-mobile',
    'overflow-hidden-tablet',
    'overflow-hidden-desktop'
  ];

  var lenis = null;
  var observer = null;

  function isScrollLocked() {
    return LOCK_CLASSES.some(function (className) {
      return document.body.classList.contains(className);
    });
  }

  function syncLockState() {
    if (!lenis) return;
    if (isScrollLocked()) {
      lenis.stop();
    } else {
      lenis.start();
    }
  }

  function init() {
    if (lenis || !document.body) return;

    lenis = new Lenis({
      autoRaf: true,
      anchors: true,
      allowNestedScroll: true
    });

    syncLockState();

    observer = new MutationObserver(syncLockState);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

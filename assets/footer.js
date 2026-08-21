/*
  Progressive enhancement for the custom footer's back-to-top control.

  The control is a real anchor pointing at the page's top fragment, so it works
  with JavaScript disabled. This script only upgrades the jump to a smooth
  scroll, routed through the theme's Lenis instance when one is running so the
  two don't fight over the scroll position.
*/
(function () {
  function scrollToTop(event) {
    var lenis = window.themeLenis;

    if (lenis && typeof lenis.scrollTo === 'function') {
      event.preventDefault();
      lenis.scrollTo(0);
    } else if ('scrollBehavior' in document.documentElement.style) {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      return; // Let the browser follow the anchor.
    }

    // Keep keyboard focus at the top of the document after the scroll.
    var target = document.getElementById('MainContent') || document.body;
    target.focus({ preventScroll: true });
  }

  document.addEventListener('click', function (event) {
    if (!event.target || typeof event.target.closest !== 'function') return;
    if (event.target.closest('[data-footer-back-to-top]')) scrollToTop(event);
  });
})();

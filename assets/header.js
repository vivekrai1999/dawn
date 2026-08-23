/*
  Publishes the navigation pill's viewport rect as custom properties so the
  search and cart panels can anchor to it exactly.

  The cart drawer is rendered at body level (layout/theme.liquid) and the pill's
  width is content-driven, so neither panel can be positioned against it in pure
  CSS. Measuring is confined to this one place: reads are batched into a single
  rAF, and the panels are positioned by CSS from the values published here.
*/
(function () {
  var root = document.documentElement;
  var pending = false;
  var pill = null;

  function publish() {
    pending = false;
    if (!pill || !pill.isConnected) {
      pill = document.querySelector('.header__pill');
      if (!pill) return;
    }
    var r = pill.getBoundingClientRect();
    if (!r.width) return;
    root.style.setProperty('--header-panel-top', Math.round(r.top) + 'px');
    root.style.setProperty('--header-panel-left', Math.round(r.left) + 'px');
    root.style.setProperty('--header-panel-width', Math.round(r.width) + 'px');
    root.style.setProperty('--header-panel-row', Math.round(r.height) + 'px');
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(publish);
  }

  function init() {
    pill = document.querySelector('.header__pill');
    if (!pill) return;
    publish();

    // The sticky header changes the pill's offset as the page scrolls.
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });

    if ('ResizeObserver' in window) {
      new ResizeObserver(schedule).observe(pill);
    }

    // Re-measure the moment a panel is asked for, before it animates in.
    document.addEventListener('click', function (event) {
      if (!event.target || typeof event.target.closest !== 'function') return;
      if (event.target.closest('.header__icon')) schedule();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // The Theme Editor re-renders the header section in place.
  document.addEventListener('shopify:section:load', function (event) {
    if (event.target && event.target.querySelector('.header__pill')) {
      pill = null;
      schedule();
    }
  });
})();

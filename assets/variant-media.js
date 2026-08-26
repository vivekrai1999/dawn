/**
 * Hero-gallery variant media swap.
 *
 * The server renders the gallery in its final order for the selected variant
 * (see snippets/product-hero-gallery.liquid): the selected variant's photos
 * first, common photos last. On every variant change, product-info.js fetches
 * the re-rendered section and publishes it on the theme's variantChange
 * event — this module simply swaps the freshly rendered slides into the live
 * track and rebuilds slick once.
 *
 * No client-side grouping, filtering or reordering.
 */
(function () {
  'use strict';

  if (window.__variantMediaSwap) return;

  function swapSlides(html) {
    var sourceTrack = html.querySelector('[data-gallery-track]');
    var liveTrack = document.querySelector('[data-gallery-track]');
    if (!sourceTrack || !liveTrack) return;

    var fresh = Array.prototype.filter.call(sourceTrack.children, function (child) {
      return child.hasAttribute('data-gallery-slide');
    });
    if (!fresh.length) return;

    var root = liveTrack.closest('product-hero-gallery');
    var $ = window.jQuery;
    var wasInitialized = liveTrack.classList.contains('slick-initialized') && $;

    if (wasInitialized) {
      $(liveTrack).slick('unslick');
    }

    liveTrack.textContent = '';
    fresh.forEach(function (node) {
      liveTrack.appendChild(document.importNode(node, true));
    });

    if (!root || typeof root.slickOptions !== 'function' || !root.$track) return;

    $(liveTrack).slick(root.slickOptions());

    // Slick marks its infinite-loop clones aria-hidden but keeps them
    // keyboard-focusable, which triggers blocked-aria-hidden warnings.
    // Clones are decorative by definition — make them inert.
    liveTrack.querySelectorAll('.slick-cloned [tabindex]').forEach(function (el) {
      el.removeAttribute('tabindex');
    });

    if (liveTrack.classList.contains('slick-initialized')) {
      $(liveTrack).slick('slickGoTo', 0, true);

      // The bar/mini thumbnails mirror the featured slide — refresh them now
      // that the new variant's slides are installed.
      if (typeof root.syncBarThumbs === 'function') root.syncBarThumbs();
    }
  }

  function init() {
    if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
      subscribe(PUB_SUB_EVENTS.variantChange, function (event) {
        var data = event && event.data;
        if (!data || !data.html || !data.variant) return;
        swapSlides(data.html);
      });
      return;
    }
    window.setTimeout(init, 200); // global.js / constants load deferred
  }

  window.__variantMediaSwap = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

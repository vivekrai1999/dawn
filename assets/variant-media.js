/**
 * <variant-media> — variant-aware product media grouping.
 *
 * Data layer:
 *   Liquid (variant-media-data.liquid) -> JSON script -> normalized map (once)
 * Resolver:
 *   Strategy objects exposing getVariantMedia(variantId) -> [mediaIds]
 *   Current strategy: "ordered" (common media prefix + per-variant ranges).
 *   A future native-Shopify strategy can replace it without touching renderers.
 * Renderers:
 *   - <media-gallery> (Dawn slider + thumbnails)
 *   - Hero gallery slick track ([data-gallery-slide], images only, repeated)
 *
 * Integration: subscribes ONCE to the theme's existing variantChange pub-sub
 * event. No second selection system, no network requests. Invalid or missing
 * configuration leaves the controller inert so the native gallery behaviour
 * is untouched.
 */
(function () {
  'use strict';

  if (window.__variantMediaController) return;

  // Debug logging: enabled by default while stabilising. Set
  // localStorage.setItem('vm-debug','0') to silence.
  var DEBUG = true;
  try {
    if (window.localStorage && window.localStorage.getItem('vm-debug') === '0') DEBUG = false;
  } catch (e) {}
  function debug() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('%c[variant-media]', 'color:#9E6168;font-weight:bold');
    console.log.apply(console, args);
  }

  var controllers = new WeakMap();

  /* ------------------------------ Resolver ------------------------------ */

  function createOrderedStrategy(data) {
    var config = data.config;
    if (!config || typeof config !== 'object') return null;

    var commonCount = parseInt(config.commonMediaCount, 10) || 0;
    var counts = config.variantMediaCounts || {};
    var total = 0;
    var hasGroups = false;

    Object.keys(counts).forEach(function (variantId) {
      var n = parseInt(counts[variantId], 10);
      if (!isNaN(n) && n > 0) {
        counts[variantId] = n;
        total += n;
        hasGroups = true;
      } else {
        delete counts[variantId];
      }
    });

    var available = data.mediaIds.length;
    if (!hasGroups || commonCount + total > available) {
      // Configured ranges overrun the actual media: unusable grouping.
      if (hasGroups) {
        console.warn(
          '[variant-media] config sums to ' +
            (commonCount + total) +
            ' media but product has ' +
            available +
            ' — falling back to native gallery behaviour.'
        );
      }
      return null;
    }

    // Pre-compute each variant's range start once: O(variants), not O(changes).
    var ranges = {};
    var cursor = commonCount;
    Object.keys(counts).forEach(function (variantId) {
      ranges[variantId] = { start: cursor, count: counts[variantId] };
      cursor += counts[variantId];
    });

    function slice(start, count) {
      return data.mediaIds.slice(start, Math.min(start + count, available));
    }

    return {
      getVariantMedia: function (variantId) {
        var ids = slice(0, commonCount);
        var range = ranges[variantId];
        if (range) ids = ids.concat(slice(range.start, range.count));
        return ids;
      },
      isExplicit: true,
    };
  }

  /*
    Anchored strategy — derived purely from Shopify's native
    variant -> featured_media associations, matching the merchant workflow of
    uploading each variant's photos in sequence and assigning the FIRST photo
    of every sequence to its variant.

      media:   [m1] [m2] [m3] [m4] [m5] ...
               |-- common --|--A--|--B--| ...   (A/B = anchored variants)

    - Media before the first anchor are common.
    - A variant's group runs from its own anchor up to (excluding) the next
      anchor; the last anchored variant also owns any trailing media.
    - Variants without an anchor show common media only.
  */
  function createAnchoredStrategy(data) {
    var indexOfMedia = {};
    data.mediaIds.forEach(function (id, index) {
      indexOfMedia[String(id)] = index;
    });

    var anchors = [];
    data.variants.forEach(function (variant) {
      if (!variant.featuredMediaId) return;
      var index = indexOfMedia[String(variant.featuredMediaId)];
      if (index !== undefined) {
        anchors.push({ variantId: String(variant.id), index: index });
      }
    });

    if (!anchors.length) return null;
    anchors.sort(function (a, b) {
      return a.index - b.index;
    });

    var ranges = {};
    anchors.forEach(function (anchor, i) {
      var end = i + 1 < anchors.length ? anchors[i + 1].index : data.mediaIds.length;
      ranges[anchor.variantId] = { start: anchor.index, count: end - anchor.index };
    });

    var commonCount = anchors[0].index;

    function slice(start, count) {
      return data.mediaIds.slice(start, Math.min(start + count, data.mediaIds.length));
    }

    return {
      getVariantMedia: function (variantId) {
        var ids = slice(0, commonCount);
        var range = ranges[variantId];
        if (range) ids = ids.concat(slice(range.start, range.count));
        return ids;
      },
      isExplicit: false,
    };
  }

  function pickStrategy(data) {
    // An explicit merchant config always wins — including by going inert when
    // it is invalid (native gallery behaviour). Anchors are only used when no
    // config was provided at all.
    var explicit =
      data.config &&
      (parseInt(data.config.commonMediaCount, 10) > 0 ||
        (data.config.variantMediaCounts && Object.keys(data.config.variantMediaCounts).length));
    if (explicit) return createOrderedStrategy(data);
    return createAnchoredStrategy(data);
  }

  /* --------------------------- Data + controller ------------------------ */

  function parseData(root) {
    var script = root.querySelector('[data-variant-media-data]');
    if (!script) return null;
    try {
      return JSON.parse(script.textContent);
    } catch (error) {
      console.warn('[variant-media] invalid JSON payload', error);
      return null;
    }
  }

  function getFeaturedMediaId(data, variantId) {
    for (var i = 0; i < data.variants.length; i++) {
      if (String(data.variants[i].id) === String(variantId)) {
        return data.variants[i].featuredMediaId;
      }
    }
    return null;
  }

  function getController(root) {
    if (controllers.has(root)) return controllers.get(root);

    var data = parseData(root);
    if (!data || !data.config) {
      // No explicit config: still try the native-anchor derivation below.
      if (!data) {
        debug('no payload — inert', root);
        return null;
      }
      data.config = {};
    }

    debug(
      'payload: media=' + data.mediaIds.length,
      'variants=' + data.variants.length,
      'repeat=' + data.repeatCount,
      'config=', data.config
    );

    var strategy = pickStrategy(data);
    if (!strategy) {
      debug('no strategy (inert, native gallery behaviour)', root);
      return null;
    }
    debug('strategy:', strategy.isExplicit ? 'ordered (metafield config)' : 'anchored (native variant images)');

    var controller = { data: data, strategy: strategy, pendingVariantId: null };
    controllers.set(root, controller);
    return controller;
  }

  /* ------------------------------ Renderers ----------------------------- */

  function pauseVideos() {
    if (typeof window.pauseAllMedia === 'function') window.pauseAllMedia();
  }

  /* Dawn <media-gallery>: toggle list items and thumbnails via [hidden]. */
  function applyToMediaGallery(root, controller, allowedSet, targetMediaId) {
    var viewerItems = root.querySelectorAll('.product__media-list > li[data-media-id]');
    var thumbnails = root.querySelectorAll('[data-target]');
    if (!viewerItems.length) return false;

    var fullId = controller.data.sectionId + '-' + targetMediaId;
    var activeItem = root.querySelector('.product__media-list > li.is-active');
    var activeHidden = activeItem && !allowedSet.has(activeItem.dataset.mediaId.slice(controller.data.sectionId.length + 1));

    viewerItems.forEach(function (item) {
      var id = item.dataset.mediaId.slice(controller.data.sectionId.length + 1);
      var show = allowedSet.has(id);
      item.hidden = !show;
      item.setAttribute('aria-hidden', show ? 'false' : 'true');
    });
    thumbnails.forEach(function (thumb) {
      var id = thumb.dataset.target.slice(controller.data.sectionId.length + 1);
      var show = allowedSet.has(id);
      thumb.hidden = !show;
      thumb.setAttribute('aria-hidden', show ? 'false' : 'true');
    });

    pauseVideos();

    var gallery = root.matches('media-gallery') ? root : root.querySelector('media-gallery');
    if (gallery && typeof gallery.setActiveMedia === 'function' && (!activeItem || activeHidden)) {
      gallery.setActiveMedia(fullId, false);
    }
    return true;
  }

  /* Hero gallery: slick must re-filter its clones, so use slickFilter. */
  function applyToHeroGallery(root, controller, allowedList, targetMediaId) {
    var track = root.querySelector('[data-gallery-track]');
    if (!track) return false;

    var selector = allowedList
      .map(function (id) {
        return '[data-gallery-slide][data-media-id="' + id + '"]';
      })
      .join(',');

    var $ = window.jQuery;
    var initialized = track.classList.contains('slick-initialized');
    debug('hero: slick initialized?', initialized, 'jquery?', !!$);

    if (!$ || !initialized) {
      /*
        Slick is not ready (typically the first paint): touching the DOM here
        would poison slick's clones with inline styles. Remember the intent
        and retry until slick has booted, then filter properly.
      */
      controller.pendingVariantId = controller.lastVariantId || null;
      debug('hero: slick not ready — scheduling retry for variant', controller.pendingVariantId);

      var attempts = 0;
      (function retry() {
        attempts += 1;
        if (attempts > 40) {
          debug('hero: retry gave up after', attempts, 'attempts');
          return;
        }
        window.setTimeout(function () {
          var ready = track.classList.contains('slick-initialized');
          debug('hero: retry #' + attempts, 'slick ready?', ready);
          if (!ready) return retry();

          var stillPending = controllers.get(root);
          if (!stillPending || !stillPending.pendingVariantId) return;
          var pending = stillPending.pendingVariantId;
          stillPending.pendingVariantId = null;
          debug('hero: retry applying pending variant', pending);
          apply(root, pending);
        }, 250);
      })();
      return true;
    }

    var slickApi = $(track).slick('getSlick') || {};
    var slickOpts = slickApi.options || {};
    if (!controller.baseOptions) {
      controller.baseOptions = {
        slidesToShow: slickOpts.slidesToShow || 1,
        infinite: slickOpts.infinite !== false,
      };
      debug('hero: base slick options', controller.baseOptions);
    }

    $(track).slick('slickUnfilter');

    /*
      Slick cannot run in infinite mode when the slide count is close to or
      below slidesToShow — the track renders blank. Shrink the view to one
      less than the group size so the clones can still loop, and restore the
      merchant's defaults when a larger group comes back.
    */
    var base = controller.baseOptions;
    var count = allowedList.length;
    if (count <= base.slidesToShow) {
      var compactShow = Math.max(count - 1, 1);
      var compactInfinite = count > 1;
      $(track).slick(
        'slickSetOption',
        { slidesToShow: compactShow, infinite: compactInfinite },
        true
      );
      debug('hero: compact mode — slidesToShow', compactShow, 'infinite', compactInfinite);
    } else {
      $(track).slick(
        'slickSetOption',
        { slidesToShow: base.slidesToShow, infinite: base.infinite },
        true
      );
    }

    $(track).slick('slickFilter', selector);
    debug('hero: filtered to', allowedList, '(selector: ' + selector + ')');

    var repeat = Math.max(parseInt(controller.data.repeatCount, 10) || 1, 1);
    var position = allowedList.indexOf(targetMediaId) * repeat;
    $(track).slick('slickGoTo', Math.max(position, 0), true);
    debug('hero: jumped to filtered position', Math.max(position, 0));
    controller.pendingVariantId = null;
    return true;
  }

  /* ------------------------------ Application --------------------------- */

  function apply(root, variantId) {
    var controller = getController(root);
    if (!controller) return;

    var mediaIds = controller.strategy.getVariantMedia(variantId);
    debug('apply variant', variantId, '→ media', mediaIds);
    if (!mediaIds.length) return;

    controller.lastVariantId = variantId;

    var allowedSet = new Set(mediaIds);
    var featured = getFeaturedMediaId(controller.data, variantId);
    var target = featured && allowedSet.has(String(featured)) ? String(featured) : mediaIds[0];
    debug('active target media:', target, '(featured:', featured + ')');

    if (root.matches('media-gallery')) {
      debug('branch: media-gallery');
      applyToMediaGallery(root, controller, allowedSet, target);
    } else {
      debug('branch: hero gallery');
      applyToHeroGallery(root, controller, mediaIds, target);
    }
  }

  function applyToAll(variantId) {
    var roots = document.querySelectorAll('[data-variant-media-data]');
    debug('applyToAll', variantId, '— payloads found:', roots.length);
    roots.forEach(function (script) {
      var root = findGalleryRoot(script);
      if (root) apply(root, variantId);
      else debug('no gallery root found for payload script');
    });
  }

  /*
    The payload script is rendered inside the gallery, but possibly nested in
    wrapper divs — walk up to the element this controller actually drives.
  */
  function findGalleryRoot(script) {
    var el = script.parentElement;
    if (!el) return null;
    if (typeof el.closest === 'function') {
      return el.closest('media-gallery, product-hero-gallery') || el;
    }
    return el;
  }

  /* ------------------------------ Wiring ------------------------------- */

  function findSelectedVariantId(root) {
    var scopes = [root, typeof root.closest === 'function' ? root.closest('product-info') : null, document];
    for (var i = 0; i < scopes.length; i++) {
      var scope = scopes[i];
      if (!scope || !scope.querySelector) continue;
      var script = scope.querySelector('[data-selected-variant]');
      if (!script) continue;
      try {
        var variant = JSON.parse(script.textContent);
        if (variant && variant.id) return variant.id;
      } catch (error) {
        /* try next scope */
      }
    }
    return null;
  }

  function initialApply() {
    document.querySelectorAll('[data-variant-media-data]').forEach(function (script) {
      var root = findGalleryRoot(script);
      if (!root) return;
      var variantId = findSelectedVariantId(root);
      debug('initial apply — selected variant:', variantId, 'root:', root.tagName || root.nodeName);
      if (variantId) apply(root, variantId);
    });
  }

  function initSubscription() {
    /*
      Bare identifier checks, not window.* : pubsub.js's `subscribe` is a
      classic-script function (window property), but PUB_SUB_EVENTS is a
      top-level const in constants.js, which never lands on window.
    */
    if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
      debug('subscribed to variantChange');
      subscribe(PUB_SUB_EVENTS.variantChange, function (event) {
        var variantId = event && event.data && event.data.variant ? event.data.variant.id : null;
        debug('variantChange event →', variantId);
        if (variantId) applyToAll(variantId);
      });
      return;
    }
    debug(
      'pubsub not ready yet',
      '(subscribe:', typeof subscribe + ', PUB_SUB_EVENTS:', typeof PUB_SUB_EVENTS + ') retrying...'
    );
    window.setTimeout(initSubscription, 200); // global.js loads deferred
  }

  window.__variantMediaController = { apply: applyToAll };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initialApply();
      initSubscription();
    });
  } else {
    initialApply();
    initSubscription();
  }
})();

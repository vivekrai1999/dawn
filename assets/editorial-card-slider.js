/*
  <editorial-card-slider> — wraps Slick Carousel for
  sections/editorial-card-slider.liquid.

  Built as a custom element to match the theme's architecture (slider-component,
  hero-carousel, cart-drawer …). That gives correct Theme Editor behaviour
  without shopify:section:load / shopify:section:unload listeners: Shopify
  replaces the section's markup, so the old element is disconnected — destroying
  its Slick instance — and the new one is upgraded and initialised.

  Every instance resolves its nodes from `this`, so any number of these sections
  can share a page without touching each other's state, and nothing is written
  to window. jQuery and Slick are read off window only if the theme has already
  loaded them; the section degrades to a plain scrolling row otherwise.
*/
if (!customElements.get('editorial-card-slider')) {
  class EditorialCardSlider extends HTMLElement {
    connectedCallback() {
      // A double upgrade must not re-initialise the same element.
      if (this.initialized) return;

      this.slider = this.querySelector('[data-editorial-track]');
      if (!this.slider) return;

      this.slides = this.querySelectorAll('[data-editorial-slide]');
      if (!this.slides.length) return;

      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.onMotionChange = this.handleReducedMotion.bind(this);
      this.onBlockSelect = this.handleBlockSelect.bind(this);
      this.onBlockDeselect = this.handleBlockDeselect.bind(this);
      this.onResize = this.updateCurve.bind(this);

      // The arc is anchored to the viewport, not to card order, so it is driven
      // from each card's live horizontal position rather than :nth-child.
      this.curveAngle = parseFloat(this.dataset.curveAngle) || 0;
      this.curveDepth = parseFloat(this.dataset.curveDepth) || 0;
      this.curved = this.curveAngle > 0 || this.curveDepth > 0;

      this.initialize();
    }

    disconnectedCallback() {
      this.destroy();
    }

    initialize() {
      const jq = window.jQuery;
      // No library: the CSS fallback leaves a usable horizontal scroller, so
      // failing here costs the merchant nothing but the arrows.
      if (!jq || !jq.fn || !jq.fn.slick) {
        this.classList.add('editorial-slider--unslicked');
        return;
      }

      this.$slider = jq(this.slider);
      this.initialized = true;

      this.$slider.on('init.editorial reInit.editorial', this.hideClonesFromA11y.bind(this));
      this.$slider.slick(this.slickOptions());

      // setPosition fires on init and on every resize/breakpoint change, which is
      // exactly when the swipe threshold needs recomputing.
      this.onSwipeThreshold = this.updateSwipeThreshold.bind(this);
      this.$slider.on('setPosition.editorial', this.onSwipeThreshold);
      this.updateSwipeThreshold();

      if (this.curved) {
        // The flag has to land on the section, where the other modifier classes
        // live — the no-JS fallback is gated by :not() on that same element.
        this.section = this.closest('.editorial-slider') || this;
        this.section.classList.add('editorial-slider--curve-active');
        this.$slider.on('setPosition.editorial afterChange.editorial', this.onResize);
        this.$slider.on('beforeChange.editorial', this.startCurveTracking.bind(this));
        this.updateCurve();
      }

      this.bindEvents();
    }

    /*
      Slides-to-show is authored per breakpoint as a decimal so a partial card
      peeks in at the edge — the cue that the row scrolls.
    */
    slickOptions() {
      const data = this.dataset;
      const reduce = this.reducedMotion.matches;
      const num = (value, fallback) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      };

      const desktop = num(data.slidesDesktop, 5);
      const tablet = num(data.slidesTablet, 3);
      const mobile = num(data.slidesMobile, 1.2);

      return {
        // Markup is authored in Liquid; Slick adopts these nodes as its controls.
        prevArrow: this.querySelector('[data-editorial-prev]') || false,
        nextArrow: this.querySelector('[data-editorial-next]') || false,
        appendDots: this.querySelector('[data-editorial-dots]') || this,

        arrows: data.arrows === 'true',
        dots: data.dots === 'true',
        infinite: data.infinite === 'true',
        // Reduced motion: no auto-advance and effectively no transition, but
        // every control keeps working.
        autoplay: reduce ? false : data.autoplay === 'true',
        autoplaySpeed: parseInt(data.autoplaySpeed, 10) || 5000,
        speed: reduce ? 1 : parseInt(data.speed, 10) || 600,
        pauseOnHover: true,
        pauseOnFocus: true,
        pauseOnDotsHover: true,
        slidesToShow: desktop,
        // Whole-card steps: a fractional scroll would leave cards half-cropped.
        slidesToScroll: 1,
        swipeToSlide: true,
        draggable: true,
        // Replaced immediately by updateSwipeThreshold, which scales it to width.
        touchThreshold: 10,
        accessibility: true,
        adaptiveHeight: false,
        cssEase: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        customPaging: (slider, i) => {
          const label = this.dataset.slideLabel || 'Slide';
          return '<button type="button" aria-label="' + label + ' ' + (i + 1) + '">' + (i + 1) + '</button>';
        },
        responsive: [
          { breakpoint: 1200, settings: { slidesToShow: Math.min(desktop, tablet + 1) } },
          { breakpoint: 990, settings: { slidesToShow: tablet } },
          { breakpoint: 750, settings: { slidesToShow: mobile } },
        ],
      };
    }

    /*
      Slick only commits a swipe after listWidth / touchThreshold pixels of drag.
      The stock threshold of 5 is fine for a boxed carousel, but this row is
      full-bleed, so the list is the whole window and a flick would have to travel
      ~380px on a desktop monitor before anything moved — which reads as the
      slider simply not responding. Deriving the threshold from the current width
      keeps the required drag near 60px at every size, and it is recomputed on
      resize because listWidth changes with the viewport.
    */
    updateSwipeThreshold() {
      if (!this.$slider) return;
      const list = this.querySelector('.slick-list');
      if (!list) return;
      const width = list.getBoundingClientRect().width;
      if (!width) return;
      // Floor of 4 keeps a narrow phone from becoming hair-trigger.
      const threshold = Math.max(4, Math.round(width / 60));
      this.$slider.slick('slickSetOption', 'touchThreshold', threshold, false);
    }

    /*
      Maps each card's centre to t in [-1, 1] across the slider, then leans it
      outward and lifts the middle of the row — the arc the reference sits on.
      Cards keep their own position as they travel, so the curve stays put.
    */
    updateCurve() {
      if (!this.curved) return;
      const box = this.getBoundingClientRect();
      const half = box.width / 2;
      if (!half) return;
      const mid = box.left + half;

      this.querySelectorAll('.editorial-slider__card').forEach((card) => {
        const b = card.getBoundingClientRect();
        let t = (b.left + b.width / 2 - mid) / half;
        t = Math.max(-1, Math.min(1, t));
        // Outward lean: negative t (left of centre) leans clockwise.
        card.style.setProperty('--curve-angle', (-t * this.curveAngle).toFixed(2));
        // Middle of the row sits lowest, so both edges of the strip curve up.
        card.style.setProperty('--curve-lift', ((1 - t * t) * this.curveDepth).toFixed(1));
      });
    }

    /*
      During a transition the cards move every frame, so the arc is recomputed on
      a rAF loop for the length of the slide. It stops as soon as Slick settles.
    */
    startCurveTracking() {
      if (!this.curved || this.curveRaf) return;
      const speed = parseInt(this.dataset.speed, 10) || 600;
      const until = performance.now() + speed + 80;
      const step = () => {
        this.updateCurve();
        if (performance.now() < until) {
          this.curveRaf = requestAnimationFrame(step);
        } else {
          this.curveRaf = null;
          this.updateCurve();
        }
      };
      this.curveRaf = requestAnimationFrame(step);
    }

    bindEvents() {
      if (this.curved) window.addEventListener('resize', this.onResize);
      if (this.reducedMotion.addEventListener) {
        this.reducedMotion.addEventListener('change', this.onMotionChange);
      }
      // Theme Editor only: bring the slide a merchant just selected into view.
      // Section load/unload is already covered by the custom element lifecycle.
      if (window.Shopify && window.Shopify.designMode) {
        this.addEventListener('shopify:block:select', this.onBlockSelect);
        this.addEventListener('shopify:block:deselect', this.onBlockDeselect);
      }
    }

    handleBlockSelect(event) {
      if (!this.$slider) return;
      const slide = event.target.closest('[data-editorial-slide]');
      if (!slide) return;
      const index = slide.dataset.editorialIndex;
      if (index !== undefined) this.$slider.slick('slickGoTo', parseInt(index, 10));
      this.$slider.slick('slickPause');
    }

    handleBlockDeselect() {
      if (!this.$slider) return;
      if (this.dataset.autoplay === 'true' && !this.reducedMotion.matches) {
        this.$slider.slick('slickPlay');
      }
    }

    /* Re-applies autoplay when the visitor changes their motion preference. */
    handleReducedMotion() {
      if (!this.$slider) return;
      if (this.reducedMotion.matches) {
        this.$slider.slick('slickPause');
        this.$slider.slick('slickSetOption', 'autoplay', false, false);
      } else if (this.dataset.autoplay === 'true') {
        this.$slider.slick('slickSetOption', 'autoplay', true, false);
        this.$slider.slick('slickPlay');
      }
    }

    /*
      Slick's infinite mode clones slides. The clones are aria-hidden, but their
      headings and links still reach the accessibility tree and the tab order,
      so a screen reader would meet every card twice.
    */
    hideClonesFromA11y() {
      this.querySelectorAll('.slick-cloned').forEach((clone) => {
        clone.setAttribute('aria-hidden', 'true');
        clone.querySelectorAll('a, button').forEach((node) => node.setAttribute('tabindex', '-1'));
        clone.querySelectorAll('h1, h2, h3, h4').forEach((heading) => {
          const plain = document.createElement('div');
          plain.className = heading.className;
          plain.textContent = heading.textContent;
          heading.replaceWith(plain);
        });
      });
    }

    destroy() {
      if (this.reducedMotion && this.reducedMotion.removeEventListener) {
        this.reducedMotion.removeEventListener('change', this.onMotionChange);
      }
      this.removeEventListener('shopify:block:select', this.onBlockSelect);
      this.removeEventListener('shopify:block:deselect', this.onBlockDeselect);
      window.removeEventListener('resize', this.onResize);
      if (this.section) this.section.classList.remove('editorial-slider--curve-active');
      if (this.curveRaf) {
        cancelAnimationFrame(this.curveRaf);
        this.curveRaf = null;
      }
      if (this.$slider) {
        this.$slider.off('.editorial');
        // unslick restores the original markup so a re-render starts clean.
        if (this.$slider.hasClass('slick-initialized')) this.$slider.slick('unslick');
        this.$slider = null;
      }
      this.initialized = false;
    }
  }

  customElements.define('editorial-card-slider', EditorialCardSlider);
}

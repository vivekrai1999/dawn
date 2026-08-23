/*
  <hero-carousel> — wraps Slick Carousel for sections/hero-carousel.liquid.

  Implemented as a custom element to match the theme's architecture
  (slider-component, cart-drawer, header-drawer …). That also gives correct
  Theme Editor behaviour for free: Shopify replaces the section's markup, so the
  old element is disconnected (destroying its Slick instance) and the new one is
  upgraded and initialised. No shopify:section:* listeners are needed.

  Every instance resolves its own nodes from `this`, so several hero carousels
  can live on one page without sharing state, and nothing is written to window.
*/
if (!customElements.get('hero-carousel')) {
  class HeroCarousel extends HTMLElement {
    connectedCallback() {
      // Guard against a double upgrade re-initialising the same element.
      if (this.initialized) return;

      this.slider = this.querySelector('[data-hero-slider]');
      if (!this.slider) return;

      this.slides = this.querySelectorAll('[data-hero-slide]');
      // One slide needs no carousel at all: no library work, no controls.
      if (this.slides.length < 2) {
        this.classList.add('hero-carousel--single');
        return;
      }

      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.onMotionChange = this.handleReducedMotion.bind(this);

      this.initialize();
    }

    disconnectedCallback() {
      this.destroy();
    }

    initialize() {
      const jq = window.jQuery;
      if (!jq || !jq.fn || !jq.fn.slick) return;

      this.$slider = jq(this.slider);
      this.initialized = true;

      this.$slider.on('init.hero reInit.hero afterChange.hero', this.onSlideChange.bind(this));
      this.$slider.on('init.hero reInit.hero', this.demoteClonedHeadings.bind(this));
      this.$slider.slick(this.slickOptions());

      this.bindEvents();
    }

    slickOptions() {
      const data = this.dataset;
      const reduce = this.reducedMotion.matches;

      return {
        // Markup is authored in Liquid; Slick adopts these nodes as its controls.
        prevArrow: this.querySelector('[data-hero-prev]') || false,
        nextArrow: this.querySelector('[data-hero-next]') || false,
        appendDots: this.querySelector('[data-hero-dots]') || this,

        arrows: data.arrows === 'true',
        dots: data.dots === 'true',
        infinite: data.infinite === 'true',
        fade: data.transition === 'fade',
        // Reduced motion: no auto-advance and effectively no transition, but
        // every control keeps working.
        autoplay: reduce ? false : data.autoplay === 'true',
        autoplaySpeed: parseInt(data.autoplaySpeed, 10) || 6000,
        speed: reduce ? 1 : parseInt(data.speed, 10) || 600,
        pauseOnHover: data.pauseOnHover === 'true',
        pauseOnFocus: true,
        pauseOnDotsHover: true,
        slidesToShow: 1,
        slidesToScroll: 1,
        adaptiveHeight: false,
        accessibility: true,
        draggable: true,
        swipeToSlide: true,
        cssEase: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        customPaging: (slider, i) => {
          const label = this.dataset.slideLabel || 'Slide';
          return `<button type="button" aria-label="${label} ${i + 1}">${i + 1}</button>`;
        },
      };
    }

    bindEvents() {
      if (this.reducedMotion.addEventListener) {
        this.reducedMotion.addEventListener('change', this.onMotionChange);
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
      Slick's infinite mode clones slides, which would duplicate the first
      slide's <h1> in the DOM — two H1s on the page, and extra headings in the
      document outline. Clones are aria-hidden already, so the fix is only about
      semantics for crawlers: swap the cloned heading for a plain element that
      carries the same styling.
    */
    demoteClonedHeadings() {
      this.querySelectorAll('.slick-cloned :is(h1, h2, h3)').forEach((heading) => {
        const plain = document.createElement('div');
        plain.className = heading.className;
        plain.textContent = heading.textContent;
        heading.replaceWith(plain);
      });
    }

    /* Keeps the optional "01 / 04" counter in step with the active slide. */
    onSlideChange(event, slick, current) {
      const counter = this.querySelector('[data-hero-counter-current]');
      if (!counter) return;
      const index = typeof current === 'number' ? current : slick.currentSlide || 0;
      counter.textContent = String(index + 1).padStart(2, '0');
    }

    destroy() {
      if (this.reducedMotion && this.reducedMotion.removeEventListener) {
        this.reducedMotion.removeEventListener('change', this.onMotionChange);
      }
      if (this.$slider) {
        this.$slider.off('.hero');
        // unslick restores the original markup so a re-render starts clean.
        if (this.$slider.hasClass('slick-initialized')) this.$slider.slick('unslick');
        this.$slider = null;
      }
      this.initialized = false;
    }
  }

  customElements.define('hero-carousel', HeroCarousel);
}

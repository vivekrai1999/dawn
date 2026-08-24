/*
  <product-hero-gallery> — immersive product gallery + sticky purchase bar for
  sections/product-hero-gallery.liquid.

  Follows the same custom-element contract as editorial-card-slider.js and
  hero-carousel.js: every instance resolves its nodes from `this`, nothing is
  written to window, and Slick is destroyed in disconnectedCallback so the Theme
  Editor's re-render lifecycle is handled without shopify:section:* listeners.

  Reused from the theme: the vendored jQuery + Slick 1.8.1 pair, Dawn's
  <variant-selects> / <product-form> / <quantity-input> custom elements (the
  purchase controls are Dawn snippets, so add-to-cart already talks to the real
  cart). Nothing new is vendored, and no second slider library is introduced.

  The sticky bar is CSS `position: sticky` — the JS here only reflects state
  (docked / variant changes / slide position) so that breakpoint behaviour stays
  in the stylesheet rather than in viewport checks.
*/
/*
  A dropdown built for this block rather than borrowed from the theme, so the
  bar can present Colour and Quantity as the matching pill triggers the design
  calls for.

  It is presentational only. The native <select> / <input> it is built from
  stays in the DOM and in the form; choosing an option writes the value back and
  dispatches a real `change`, so Dawn's <variant-selects> and <product-form>
  keep doing all the variant, pricing and cart work. Nothing about the commerce
  logic is reimplemented here.
*/
class HeroGalleryDropdown {
  constructor(source, labelText) {
    this.source = source;
    this.labelText = labelText;
    this.open = false;

    this.onDocumentClick = this.handleDocumentClick.bind(this);
    this.onKeydown = this.handleKeydown.bind(this);

    this.build();
  }

  static get CARET() {
    return '<svg class="hg-dropdown__caret" viewBox="0 0 10 6" aria-hidden="true" focusable="false"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  /* Options come from the native control, so they always agree with the form. */
  readOptions() {
    if (this.source.tagName === 'SELECT') {
      return Array.from(this.source.options).map((o) => ({
        value: o.value,
        label: o.textContent.trim(),
        disabled: o.disabled,
      }));
    }

    // Number input: derive a sensible range from its own min/max/step.
    const min = parseInt(this.source.min, 10) || 1;
    const step = parseInt(this.source.step, 10) || 1;
    const rawMax = parseInt(this.source.max, 10);
    const max = Number.isFinite(rawMax) ? rawMax : min + step * 9;

    const out = [];
    for (let v = min; v <= max && out.length < 20; v += step) {
      out.push({ value: String(v), label: String(v), disabled: false });
    }
    return out;
  }

  build() {
    const id = Math.random().toString(36).slice(2, 9);

    this.el = document.createElement('div');
    this.el.className = 'hg-dropdown';

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'hg-dropdown__trigger';
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.id = 'hg-trigger-' + id;

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'hg-dropdown__label';
    this.labelEl.textContent = this.labelText;

    this.valueEl = document.createElement('span');
    this.valueEl.className = 'hg-dropdown__value';

    this.trigger.append(this.labelEl, this.valueEl);
    this.trigger.insertAdjacentHTML('beforeend', HeroGalleryDropdown.CARET);

    this.panel = document.createElement('ul');
    this.panel.className = 'hg-dropdown__panel';
    this.panel.setAttribute('role', 'listbox');
    this.panel.setAttribute('aria-labelledby', this.trigger.id);
    this.panel.hidden = true;

    this.el.append(this.trigger, this.panel);

    this.renderOptions();
    this.syncValue();

    this.trigger.addEventListener('click', () => this.toggle());
    this.el.addEventListener('keydown', this.onKeydown);

    // Keep the trigger honest if anything else changes the underlying control
    // (Dawn swapping variants, the stepper buttons, a browser autofill).
    this.onSourceChange = this.syncValue.bind(this);
    this.source.addEventListener('change', this.onSourceChange);
  }

  renderOptions() {
    this.panel.textContent = '';

    this.readOptions().forEach((opt) => {
      const li = document.createElement('li');
      li.className = 'hg-dropdown__option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.tabIndex = -1;
      li.textContent = opt.label;
      if (opt.disabled) {
        li.setAttribute('aria-disabled', 'true');
        li.classList.add('is-disabled');
      }
      li.addEventListener('click', () => {
        if (opt.disabled) return;
        this.select(opt.value);
      });
      this.panel.appendChild(li);
    });
  }

  syncValue() {
    const value = String(this.source.value);
    this.valueEl.textContent = value;

    this.panel.querySelectorAll('.hg-dropdown__option').forEach((li) => {
      const match = li.dataset.value === value;
      li.setAttribute('aria-selected', match ? 'true' : 'false');
      li.classList.toggle('is-selected', match);
    });
  }

  /*
    Writing to the native control and dispatching `change` is the whole point of
    the component — everything downstream reacts exactly as it would have to a
    real user interaction with the original control.
  */
  select(value) {
    this.source.value = value;
    this.source.dispatchEvent(new Event('change', { bubbles: true }));
    this.syncValue();
    this.close(true);
  }

  toggle() {
    this.open ? this.close(true) : this.show();
  }

  show() {
    this.open = true;
    this.panel.hidden = false;
    this.el.classList.add('is-open');
    this.trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', this.onDocumentClick);

    const selected = this.panel.querySelector('.is-selected') || this.panel.firstElementChild;
    if (selected) selected.focus();
  }

  close(returnFocus) {
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    this.el.classList.remove('is-open');
    this.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', this.onDocumentClick);
    if (returnFocus) this.trigger.focus();
  }

  handleDocumentClick(event) {
    if (!this.el.contains(event.target)) this.close(false);
  }

  handleKeydown(event) {
    const options = Array.from(this.panel.querySelectorAll('.hg-dropdown__option'));

    switch (event.key) {
      case 'Escape':
        if (this.open) {
          event.preventDefault();
          this.close(true);
        }
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!this.open) return this.show();
        const i = options.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? i + 1 : i - 1;
        const target = options[(next + options.length) % options.length];
        if (target) target.focus();
        break;
      }
      case 'Enter':
      case ' ':
        if (this.open && document.activeElement.classList.contains('hg-dropdown__option')) {
          event.preventDefault();
          this.select(document.activeElement.dataset.value);
        }
        break;
      default:
        break;
    }
  }

  destroy() {
    document.removeEventListener('click', this.onDocumentClick);
    this.source.removeEventListener('change', this.onSourceChange);
    if (this.el.parentNode) this.el.remove();
  }
}

if (!customElements.get('product-hero-gallery')) {
  class ProductShowcase extends HTMLElement {
    connectedCallback() {
      // A double upgrade must not re-initialise the same element.
      if (this.initialized) return;

      this.track = this.querySelector('[data-gallery-track]');
      if (!this.track) return;

      this.slides = this.querySelectorAll('[data-gallery-slide]');
      if (!this.slides.length) return;

      this.bar = this.querySelector('[data-gallery-bar]');
      this.counter = this.querySelector('[data-gallery-counter-current]');
      this.liveRegion = this.querySelector('[data-gallery-live]');

      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.onMotionChange = this.handleReducedMotion.bind(this);
      this.onBlockSelect = this.handleBlockSelect.bind(this);
      this.onVariantChange = this.handleVariantChange.bind(this);

      this.initialize();
    }

    disconnectedCallback() {
      this.destroy();
    }

    initialize() {
      const jq = window.jQuery;

      // No library: the CSS fallback leaves a usable scroll-snap row, so failing
      // here costs the shopper nothing but the arrows.
      if (!jq || !jq.fn || !jq.fn.slick) {
        this.classList.add('product-hero-gallery--unslicked');
        this.observeBar();
        this.bindEvents();
        return;
      }

      this.$track = jq(this.track);
      this.initialized = true;

      this.$track.on('init.heroGallery reInit.heroGallery', this.hideClonesFromA11y.bind(this));
      this.$track.on('afterChange.heroGallery', (event, slick, index) => this.syncPosition(index));
      this.$track.slick(this.slickOptions());
      this.syncPosition(0);

      this.observeBar();
      this.bindEvents();
    }

    /*
      Slides-to-show is authored per breakpoint as a decimal so a partial panel
      peeks in at the edge — the cue that the gallery scrolls. Mobile drops to a
      single full-bleed image, matching the reference.
    */
    slickOptions() {
      const data = this.dataset;
      const reduce = this.reducedMotion.matches;
      const num = (value, fallback) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      };

      const desktop = num(data.slidesDesktop, 2.6);
      const tablet = num(data.slidesTablet, 1.6);
      const mobile = num(data.slidesMobile, 1);

      return {
        // Markup is authored in Liquid; Slick adopts these nodes as its controls.
        prevArrow: this.querySelector('[data-gallery-prev]') || false,
        nextArrow: this.querySelector('[data-gallery-next]') || false,
        appendDots: this.querySelector('[data-gallery-dots]') || this,

        arrows: data.arrows === 'true',
        dots: data.dots === 'true',
        infinite: data.infinite === 'true',

        // Reduced motion: no auto-advance and effectively no transition, but
        // every control keeps working.
        autoplay: reduce ? false : data.autoplay === 'true',
        autoplaySpeed: parseInt(data.autoplaySpeed, 10) || 3000,
        pauseOnHover: true,
        pauseOnFocus: true,
        pauseOnDotsHover: true,

        speed: reduce ? 1 : parseInt(data.speed, 10) || 500,
        slidesToShow: desktop,
        slidesToScroll: 1,
        swipeToSlide: true,
        draggable: true,
        touchThreshold: 12,
        accessibility: true,
        adaptiveHeight: false,
        // Slick's own lazy mode co-operates with the `data-lazy` attributes the
        // section emits for every non-primary image.
        lazyLoad: data.lazyload === 'true' ? 'ondemand' : 'progressive',
        cssEase: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        customPaging: (slider, i) => {
          const label = this.dataset.slideLabel || 'Image';
          return '<button type="button" aria-label="' + label + ' ' + (i + 1) + '"></button>';
        },
        responsive: [
          { breakpoint: 1400, settings: { slidesToShow: Math.min(desktop, tablet + 0.8) } },
          { breakpoint: 990, settings: { slidesToShow: tablet } },
          { breakpoint: 750, settings: { slidesToShow: mobile, arrows: false } },
        ],
      };
    }

    /*
      Keeps the "3 / 8" counter and the screen-reader announcement in step.

      The announcement is deliberately suppressed while the gallery auto-advances
      or is showing repeats of one photo: a polite live region firing every few
      seconds — or reporting the same image under a new number — is noise, not
      information. Manual navigation still announces normally.
    */
    syncPosition(index) {
      const current = (index || 0) + 1;
      if (this.counter) this.counter.textContent = current;

      const autoplaying = this.dataset.autoplay === 'true' && !this.reducedMotion.matches;
      const repeated = parseInt(this.dataset.repeated, 10) > 1;
      if (!this.liveRegion || autoplaying || repeated) return;

      const label = this.dataset.slideLabel || 'Image';
      this.liveRegion.textContent = label + ' ' + current + ' of ' + this.slides.length;
    }

    /*
      The bar is sticky in CSS. This only flags whether it is currently pinned
      against the gallery so the stylesheet can soften the shadow once it docks
      at the end of the section — no viewport maths in JS.
    */
    observeBar() {
      if (!this.bar || !('IntersectionObserver' in window)) return;

      const sentinel = this.querySelector('[data-gallery-sentinel]');
      if (!sentinel) return;

      this.observer = new IntersectionObserver(
        ([entry]) => this.bar.classList.toggle('is-docked', !entry.isIntersecting),
        { rootMargin: '0px 0px -1px 0px', threshold: 0 }
      );
      this.observer.observe(sentinel);
    }

    bindEvents() {
      if (this.reducedMotion.addEventListener) {
        this.reducedMotion.addEventListener('change', this.onMotionChange);
      }

      // Dawn's <variant-selects> announces a variant change on the section; the
      // bar mirrors the newly selected media so thumbnail and gallery agree.
      this.addEventListener('change', this.onVariantChange);

      // Theme Editor only: bring the image a merchant just selected into view.
      if (window.Shopify && window.Shopify.designMode) {
        this.addEventListener('shopify:block:select', this.onBlockSelect);
      }
    }

    /*
      Dawn re-renders the price / buy buttons on variant change, so the bar's
      own markup is already current. All that is left is to move the gallery to
      the variant's featured image when it has one.
    */
    handleVariantChange(event) {
      if (!this.$track) return;
      const select = event.target.closest('variant-selects');
      if (!select) return;

      window.requestAnimationFrame(() => {
        const active = this.querySelector('[data-gallery-slide][data-variant-featured="true"]');
        if (!active) return;
        const index = parseInt(active.dataset.galleryIndex, 10);
        if (Number.isFinite(index)) this.$track.slick('slickGoTo', index);
      });
    }

    handleBlockSelect(event) {
      if (!this.$track) return;
      const slide = event.target.closest('[data-gallery-slide]');
      if (!slide) return;
      const index = slide.dataset.galleryIndex;
      if (index !== undefined) this.$track.slick('slickGoTo', parseInt(index, 10));
    }

    /*
      Re-applies transition speed and auto-advance when the visitor changes
      their motion preference, without needing a reload.
    */
    handleReducedMotion() {
      if (!this.$track) return;
      const reduce = this.reducedMotion.matches;

      this.$track.slick('slickSetOption', 'speed', reduce ? 1 : parseInt(this.dataset.speed, 10) || 500, false);

      if (reduce) {
        this.$track.slick('slickSetOption', 'autoplay', false, false);
        this.$track.slick('slickPause');
      } else if (this.dataset.autoplay === 'true') {
        this.$track.slick('slickSetOption', 'autoplay', true, false);
        this.$track.slick('slickPlay');
      }
    }

    /*
      Slick's infinite mode clones slides. The clones are aria-hidden, but their
      links and buttons still reach the tab order, so a keyboard user would meet
      every image twice.
    */
    hideClonesFromA11y() {
      this.querySelectorAll('.slick-cloned').forEach((clone) => {
        clone.setAttribute('aria-hidden', 'true');
        clone.querySelectorAll('a, button').forEach((node) => node.setAttribute('tabindex', '-1'));
      });
    }

    destroy() {
      if (this.reducedMotion && this.reducedMotion.removeEventListener) {
        this.reducedMotion.removeEventListener('change', this.onMotionChange);
      }
      this.removeEventListener('change', this.onVariantChange);
      this.removeEventListener('shopify:block:select', this.onBlockSelect);

      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }

      if (this.$track) {
        this.$track.off('.heroGallery');
        // unslick restores the original markup so a re-render starts clean.
        if (this.$track.hasClass('slick-initialized')) this.$track.slick('unslick');
        this.$track = null;
      }
      this.initialized = false;
    }
  }

  customElements.define('product-hero-gallery', ProductShowcase);
}

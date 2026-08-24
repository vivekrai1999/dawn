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
    this.isRadioGroup = !!(source.matches && source.matches('[data-phg-radio-group]'));
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
    /*
      A radio group — the section's own colour swatches. Every value stays
      selectable, exactly as it is in the swatch row: the theme resolves the
      nearest available variant from whatever combination is chosen.
    */
    if (this.isRadioGroup) {
      return Array.from(this.source.querySelectorAll('input[type="radio"]')).map((input) => ({
        value: input.value,
        label: input.value,
        disabled: false,
      }));
    }

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

  /* The one place that knows how to read whichever control backs this menu. */
  get currentValue() {
    if (!this.isRadioGroup) return String(this.source.value);
    const checked = this.source.querySelector('input[type="radio"]:checked');
    return checked ? String(checked.value) : '';
  }

  syncValue() {
    const value = this.currentValue;
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
    if (this.isRadioGroup) {
      const input = Array.from(this.source.querySelectorAll('input[type="radio"]')).find(
        (radio) => radio.value === value
      );
      if (!input) return;
      input.checked = true;
      // Bubbles out of the radio exactly as a click on the swatch would, so
      // <variant-selects> runs its normal variant change from here.
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      this.source.value = value;
      this.source.dispatchEvent(new Event('change', { bubbles: true }));
    }

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
      this.dropdowns = [];
      this.observers = [];

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
        this.initBar();
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
      this.initBar();
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
        /*
          Slick's default rows:1 wraps every slide in two generated divs. With
          rows:0 it leaves the authored markup alone, so the section's own slide
          element is the one Slick sizes — which is what the stylesheet targets.
        */
        rows: 0,
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

    /* ------------------------------------------------------- Sticky bar */

    /*
      The bar is a view of the purchase form, never a second copy of it. Its
      controls write to the real inputs, its price and SKU are mirrored from the
      elements the theme already re-renders on variant change, and its buttons
      forward to the real Add to cart and dynamic checkout buttons. Nothing in
      here holds product state of its own, so the two cannot drift apart.
    */
    initBar() {
      if (!this.bar) return;

      this.barControls = this.querySelector('[data-phg-bar-controls]');

      this.buildBarControls();
      this.mirrorBarState();
      this.watchForRerender();
      this.bindBarActions();
      this.initMini();
    }

    /*
      The corner widget that takes over once the sticky bar has scrolled away
      with its section. It owns no product state either: the same mirrors feed
      it, and its button clicks the page's one Add to cart.
    */
    initMini() {
      this.mini = this.querySelector('[data-phg-mini]');
      if (!this.mini) return;

      this.miniDismissed = false;

      const price = this.querySelector('[data-phg-price-source]');
      const miniPrice = this.querySelector('[data-phg-mini-price]');
      this.mirror(price, miniPrice, () => {
        miniPrice.innerHTML = price.innerHTML;
        miniPrice.hidden = price.classList.contains('hidden');
      });

      const submit = this.querySelector('[data-phg-submit]');
      const miniAdd = this.querySelector('[data-phg-mini-add]');
      this.mirror(submit, miniAdd, () => {
        const busy = submit.getAttribute('aria-disabled') === 'true';
        miniAdd.disabled = submit.hasAttribute('disabled');
        miniAdd.setAttribute('aria-disabled', busy ? 'true' : 'false');
        miniAdd.classList.toggle('loading', submit.classList.contains('loading'));
      });

      if (submit && miniAdd) {
        this.onMiniAdd = (event) => {
          event.preventDefault();
          if (miniAdd.disabled || miniAdd.getAttribute('aria-disabled') === 'true') return;
          submit.click();
        };
        miniAdd.addEventListener('click', this.onMiniAdd);
        this.miniAdd = miniAdd;
      }

      const close = this.querySelector('[data-phg-mini-close]');
      if (close) {
        // Dismissal lasts for this page view: reappearing after a shopper has
        // closed it would be nagging, not helpful.
        this.onMiniClose = () => {
          this.miniDismissed = true;
          this.mini.classList.remove('is-visible');
        };
        close.addEventListener('click', this.onMiniClose);
        this.miniClose = close;
      }

      this.syncMiniVariant();
      this.observeMini();
    }

    /*
      The widget names the selection the way the swatch legend does, read back
      from whichever inputs are currently checked — so it survives the theme
      replacing <variant-selects> wholesale on every variant change.
    */
    syncMiniVariant() {
      const target = this.querySelector('[data-phg-mini-variant]');
      if (!target) return;

      const values = Array.from(this.querySelectorAll('[data-phg-radio-group] input:checked')).map(
        (input) => input.value
      );
      if (values.length) target.textContent = values.join(' / ');
    }

    /*
      Shows the widget exactly when the section — and with it the sticky bar,
      which is sticky inside that section — has left the viewport.
    */
    observeMini() {
      if (!('IntersectionObserver' in window)) return;

      this.miniObserver = new IntersectionObserver(
        ([entry]) => {
          const show = !entry.isIntersecting && !this.miniDismissed;
          this.mini.classList.toggle('is-visible', show);
        },
        { threshold: 0 }
      );
      this.miniObserver.observe(this);
      this.observers.push(this.miniObserver);
    }

    buildBarControls() {
      if (!this.barControls) return;

      this.dropdowns.forEach((dropdown) => dropdown.destroy());
      this.dropdowns = [];
      this.barControls.textContent = '';

      this.querySelectorAll('[data-phg-option-group]').forEach((group) => {
        const radios = group.querySelector('[data-phg-radio-group]');
        if (!radios) return;
        this.addDropdown(radios, group.dataset.optionName || '');
      });

      const quantity = this.querySelector('.quantity__input');
      if (quantity) this.addDropdown(quantity, this.dataset.quantityLabel || 'Quantity');
    }

    addDropdown(source, label) {
      const dropdown = new HeroGalleryDropdown(source, label);
      this.barControls.appendChild(dropdown.el);
      this.dropdowns.push(dropdown);
    }

    /* Copies a source node into its counterpart in the bar, and keeps copying. */
    mirror(source, target, apply) {
      if (!source || !target) return;
      apply();
      const observer = new MutationObserver(apply);
      observer.observe(source, { childList: true, subtree: true, characterData: true, attributes: true });
      this.observers.push(observer);
    }

    mirrorBarState() {
      const price = this.querySelector('[data-phg-price-source]');
      const barPrice = this.querySelector('[data-phg-bar-price]');
      this.mirror(price, barPrice, () => {
        barPrice.innerHTML = price.innerHTML;
        barPrice.hidden = price.classList.contains('hidden');
      });

      const sku = this.querySelector('[data-phg-sku-source]');
      const barSku = this.querySelector('[data-phg-bar-sku]');
      this.mirror(sku, barSku, () => {
        barSku.innerHTML = sku.innerHTML;
        barSku.hidden = sku.classList.contains('hidden');
      });

      /*
        Availability and the in-flight state belong to the real submit button;
        the bar button only reflects them, so a sold-out variant or an
        add-to-cart already in progress cannot be worked around from here.
      */
      const submit = this.querySelector('[data-phg-submit]');
      const barAdd = this.querySelector('[data-phg-bar-add]');
      this.mirror(submit, barAdd, () => {
        const label = submit.querySelector('span');
        const barLabel = barAdd.querySelector('.phg-button__label');
        if (label && barLabel) barLabel.textContent = label.textContent.trim();

        const busy = submit.getAttribute('aria-disabled') === 'true';
        barAdd.disabled = submit.hasAttribute('disabled');
        barAdd.setAttribute('aria-disabled', busy ? 'true' : 'false');
        barAdd.classList.toggle('loading', submit.classList.contains('loading'));
      });
    }

    /*
      Dawn replaces the whole <variant-selects> element when a variant changes,
      which detaches the radio groups the colour menu was built from. Rebuild
      the menus once their source has left the document.
    */
    watchForRerender() {
      const info = this.querySelector('[data-phg-info]');
      if (!info || !('MutationObserver' in window)) return;

      const observer = new MutationObserver(() => {
        const stale = this.dropdowns.some((dropdown) => !this.contains(dropdown.source));
        if (stale) this.buildBarControls();
        this.syncMiniVariant();
      });
      observer.observe(info, { childList: true, subtree: true });
      this.observers.push(observer);
    }

    bindBarActions() {
      const submit = this.querySelector('[data-phg-submit]');
      const barAdd = this.querySelector('[data-phg-bar-add]');
      if (submit && barAdd) {
        this.onBarAdd = (event) => {
          event.preventDefault();
          // Guard the repeat click: the real button is already mid-request.
          if (barAdd.disabled || barAdd.getAttribute('aria-disabled') === 'true') return;
          submit.click();
        };
        barAdd.addEventListener('click', this.onBarAdd);
        this.barAdd = barAdd;
      }

      const barBuy = this.querySelector('[data-phg-bar-buy]');
      const checkout = this.querySelector('[data-phg-dynamic-checkout]');
      if (!barBuy || !checkout) return;

      /*
        Shopify renders the dynamic checkout button itself, and not always by
        the time this runs. The bar Buy it now stays hidden until the real
        button exists, and then only forwards the click to it — the checkout
        path is entirely the platform's.
      */
      const findReal = () => checkout.querySelector('.shopify-payment-button__button');
      const reveal = () => {
        const real = findReal();
        barBuy.hidden = !real;
        if (!real) return;

        // The platform's own wording, in the shopper's own language.
        const label = barBuy.querySelector('.phg-button__label');
        const text = real.textContent.trim();
        if (label && text && label.textContent !== text) label.textContent = text;
      };
      reveal();

      const observer = new MutationObserver(reveal);
      observer.observe(checkout, { childList: true, subtree: true });
      this.observers.push(observer);

      this.onBarBuy = () => {
        const real = findReal();
        if (real) real.click();
      };
      barBuy.addEventListener('click', this.onBarBuy);
      this.barBuy = barBuy;
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

        // Both thumbnails follow the gallery, so all three views agree.
        const image = active.querySelector('img');
        if (!image) return;

        this.querySelectorAll('[data-phg-bar-thumb], [data-phg-mini-thumb]').forEach((thumb) => {
          thumb.srcset = image.srcset || '';
          thumb.src = image.currentSrc || image.src;
        });
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

      if (this.barAdd && this.onBarAdd) this.barAdd.removeEventListener('click', this.onBarAdd);
      if (this.barBuy && this.onBarBuy) this.barBuy.removeEventListener('click', this.onBarBuy);
      if (this.miniAdd && this.onMiniAdd) this.miniAdd.removeEventListener('click', this.onMiniAdd);
      if (this.miniClose && this.onMiniClose) this.miniClose.removeEventListener('click', this.onMiniClose);

      (this.dropdowns || []).forEach((dropdown) => dropdown.destroy());
      this.dropdowns = [];

      (this.observers || []).forEach((observer) => observer.disconnect());
      this.observers = [];
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

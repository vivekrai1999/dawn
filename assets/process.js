/*
  <process-steps> — the tab behaviour for sections/process.liquid.

  Follows the same custom-element contract as hero-carousel.js and
  editorial-card-slider.js: every instance resolves its nodes from `this`,
  nothing is written to window, and everything it binds is released in
  disconnectedCallback, so the Theme Editor's re-render lifecycle is handled
  without shopify:section:* listeners and any number of these sections can share
  a page.

  The section renders every step's media and copy, and marks the first one
  active in Liquid. This script only moves that mark around. If it never loads,
  the first step stays on show and each step's own copy is still in the DOM —
  nothing here is required to read the section.

  The tabs follow the ARIA authoring practice for a tab list: one tab in the tab
  order at a time, arrows to move between them, Home and End for the ends.
*/
if (!customElements.get('process-steps')) {
  class ProcessSteps extends HTMLElement {
    connectedCallback() {
      this.tabs = Array.from(this.querySelectorAll('[data-process-tab]'));
      if (this.tabs.length < 2) return;

      this.panels = Array.from(this.querySelectorAll('[data-process-panel]'));
      this.items = Array.from(this.querySelectorAll('[data-process-item]'));

      this.active = this.tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
      if (this.active < 0) this.active = 0;

      this.autoplay = this.dataset.autoplay === 'true';
      this.duration = parseInt(this.dataset.autoplaySpeed, 10) || 4000;
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

      this.timer = null;
      /*
        Every reason the carousel might be held still, counted rather than kept
        as one flag: a pointer resting on the section while it is scrolled out
        of view must not resume when only one of those ends.
      */
      this.holds = new Set();

      this.onClick = this.handleClick.bind(this);
      this.onKeydown = this.handleKeydown.bind(this);
      this.onEnter = () => this.hold('pointer');
      this.onLeave = () => this.release('pointer');
      this.onFocusIn = () => this.hold('focus');
      this.onFocusOut = () => this.release('focus');
      this.onMotionChange = this.handleMotionChange.bind(this);

      this.bindEvents();
      this.select(this.active, { focus: false });
      this.start();
    }

    disconnectedCallback() {
      this.stop();

      this.removeEventListener('click', this.onClick);
      this.removeEventListener('keydown', this.onKeydown);
      this.removeEventListener('pointerenter', this.onEnter);
      this.removeEventListener('pointerleave', this.onLeave);
      this.removeEventListener('focusin', this.onFocusIn);
      this.removeEventListener('focusout', this.onFocusOut);

      if (this.reducedMotion?.removeEventListener) {
        this.reducedMotion.removeEventListener('change', this.onMotionChange);
      }

      this.observer?.disconnect();
      this.observer = null;
    }

    bindEvents() {
      this.addEventListener('click', this.onClick);
      this.addEventListener('keydown', this.onKeydown);

      if (this.autoplay) {
        // Hovering or tabbing into the section is a signal that it is being
        // read; advancing under the reader is what makes these sections
        // frustrating.
        this.addEventListener('pointerenter', this.onEnter);
        this.addEventListener('pointerleave', this.onLeave);
        this.addEventListener('focusin', this.onFocusIn);
        this.addEventListener('focusout', this.onFocusOut);

        this.observeVisibility();
      }

      if (this.reducedMotion?.addEventListener) {
        this.reducedMotion.addEventListener('change', this.onMotionChange);
      }
    }

    /* Nothing advances while the section is off screen. */
    observeVisibility() {
      if (!('IntersectionObserver' in window)) return;

      this.observer = new IntersectionObserver(
        ([entry]) => (entry.isIntersecting ? this.release('offscreen') : this.hold('offscreen')),
        { threshold: 0 }
      );
      this.observer.observe(this);
    }

    handleClick(event) {
      const tab = event.target.closest('[data-process-tab]');
      if (!tab || !this.contains(tab)) return;

      const index = this.tabs.indexOf(tab);
      if (index < 0 || index === this.active) return;

      this.select(index, { focus: false });
      // A deliberate choice deserves the full dwell before the next advance.
      this.restart();
    }

    handleKeydown(event) {
      const tab = event.target.closest('[data-process-tab]');
      if (!tab || !this.contains(tab)) return;

      const last = this.tabs.length - 1;
      let next = null;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = this.active === last ? 0 : this.active + 1;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = this.active === 0 ? last : this.active - 1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        default:
          return;
      }

      event.preventDefault();
      this.select(next, { focus: true });
      this.restart();
    }

    select(index, { focus }) {
      this.active = index;

      this.tabs.forEach((tab, i) => {
        const current = i === index;
        tab.setAttribute('aria-selected', current ? 'true' : 'false');
        // Roving tab order: one stop for the whole list, arrows for the rest.
        tab.tabIndex = current ? 0 : -1;
        if (current && focus) tab.focus();
      });

      this.panels.forEach((panel, i) => {
        panel.classList.toggle('process__panel--active', i === index);
        panel.toggleAttribute('inert', i !== index);
      });

      /*
        Where each step stands in the sequence, which is what the rail between
        the numbers is drawn from. Setting it on every change also restarts the
        countdown animation on the step now being shown, because the rule that
        carries it only matches in the `current` state.
      */
      this.items.forEach((item, i) => {
        let state = 'todo';
        if (i < index) state = 'done';
        if (i === index) state = 'current';
        item.dataset.state = state;
      });
    }

    advance() {
      this.select(this.active === this.tabs.length - 1 ? 0 : this.active + 1, { focus: false });
    }

    start() {
      if (!this.autoplay || this.reducedMotion.matches || this.holds.size) return;
      this.stop();
      this.classList.remove('is-paused');
      this.timer = window.setInterval(() => this.advance(), this.duration);
    }

    stop() {
      this.classList.add('is-paused');
      if (this.timer === null) return;
      window.clearInterval(this.timer);
      this.timer = null;
    }

    restart() {
      this.stop();
      this.start();
    }

    hold(reason) {
      this.holds.add(reason);
      this.stop();
    }

    release(reason) {
      this.holds.delete(reason);
      this.start();
    }

    /* Honours a preference changed after load, without needing a reload. */
    handleMotionChange() {
      if (this.reducedMotion.matches) {
        this.stop();
      } else {
        this.start();
      }
    }
  }

  customElements.define('process-steps', ProcessSteps);
}

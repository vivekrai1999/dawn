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

  Autoplay never relies on paired enter/leave events to decide whether to run —
  those can be missed (a focused element removed from the DOM never fires
  focusout; a layout shift under a still cursor can skip pointerleave) and one
  missed half pauses the section forever. Instead the timer keeps ticking and
  each tick re-reads the live conditions: hover, focus, viewport presence and
  reduced-motion. Nothing can get stuck.
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
      this.offscreen = false;
      this.timer = null;

      this.onClick = this.handleClick.bind(this);
      this.onKeydown = this.handleKeydown.bind(this);

      this.bindEvents();
      this.select(this.active, { focus: false });
      this.start();
    }

    disconnectedCallback() {
      this.stop();

      this.removeEventListener('click', this.onClick);
      this.removeEventListener('keydown', this.onKeydown);

      this.observer?.disconnect();
      this.observer = null;
    }

    bindEvents() {
      this.addEventListener('click', this.onClick);
      this.addEventListener('keydown', this.onKeydown);

      // Only used as a live signal read on each tick, not as a pair of events.
      if (this.autoplay && 'IntersectionObserver' in window) {
        this.observer = new IntersectionObserver(
          ([entry]) => (this.offscreen = !entry.isIntersecting),
          { threshold: 0 }
        );
        this.observer.observe(this);
      }
    }

    /*
      Every reason to hold still, evaluated fresh each tick from the current
      state of the world rather than remembered from past events.
    */
    isHeld() {
      return (
        !this.autoplay ||
        this.reducedMotion.matches ||
        this.offscreen ||
        this.matches(':hover') ||
        this.contains(document.activeElement)
      );
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
      this.stop();
      this.classList.toggle('is-paused', this.isHeld());
      this.timer = window.setInterval(() => this.tick(), this.duration);
    }

    /* One beat of the clock: advance unless something asks to hold still. */
    tick() {
      const held = this.isHeld();
      this.classList.toggle('is-paused', held);
      if (!held) this.advance();
    }

    stop() {
      this.classList.add('is-paused');
      if (this.timer === null) return;
      window.clearInterval(this.timer);
      this.timer = null;
    }

    restart() {
      this.start();
    }
  }

  customElements.define('process-steps', ProcessSteps);
}

/*
  <nav-scroller> — keeps a long header menu on one line.

  The menu list scrolls horizontally; this element decides whether that is even
  necessary and, if so, exposes two arrows to page through it. Nothing is
  hardcoded about how many items "too many" is: it measures the list against the
  space it has, so the arrows appear exactly when items would otherwise be out of
  reach, at any font size, menu length or window width.

  The arrows are a convenience for pointer users — the list is already reachable
  by trackpad, touch and keyboard — so they carry tabindex="-1" and stay out of
  the tab order rather than adding two stops in front of every menu item.
*/
if (!customElements.get('nav-scroller')) {
  class NavScroller extends HTMLElement {
    connectedCallback() {
      if (this.initialized) return;

      this.viewport = this.querySelector('[data-nav-viewport]');
      this.list = this.viewport && this.viewport.querySelector('.list-menu');
      this.prev = this.querySelector('[data-nav-prev]');
      this.next = this.querySelector('[data-nav-next]');
      if (!this.list) return;

      this.initialized = true;
      this.onScroll = this.update.bind(this);
      this.onResize = this.update.bind(this);

      this.list.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('resize', this.onResize);

      if (this.prev) this.prev.addEventListener('click', () => this.page(-1));
      if (this.next) this.next.addEventListener('click', () => this.page(1));

      /*
        Fonts and images land after first paint and change the list's width, so a
        single measurement now would be wrong. ResizeObserver re-checks whenever
        the list or its container actually changes size.
      */
      if ('ResizeObserver' in window) {
        this.observer = new ResizeObserver(() => this.update());
        this.observer.observe(this.list);
        this.observer.observe(this);
      }

      // Keeps a menu item reachable when it is focused by keyboard.
      this.list.addEventListener('focusin', (event) => {
        const item = event.target.closest('li');
        if (item) this.reveal(item);
      });

      this.update();
    }

    disconnectedCallback() {
      if (this.list) this.list.removeEventListener('scroll', this.onScroll);
      window.removeEventListener('resize', this.onResize);
      if (this.observer) this.observer.disconnect();
      this.initialized = false;
    }

    /* Scrolls by roughly one viewport, leaving a little overlap for context. */
    page(direction) {
      const step = Math.max(this.list.clientWidth * 0.8, 120);
      this.list.scrollBy({ left: step * direction, behavior: this.motion() });
    }

    reveal(item) {
      const box = item.getBoundingClientRect();
      const frame = this.list.getBoundingClientRect();
      if (box.left >= frame.left && box.right <= frame.right) return;
      item.scrollIntoView({ behavior: this.motion(), inline: 'nearest', block: 'nearest' });
    }

    motion() {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    }

    update() {
      // 1px of slack: sub-pixel layout can leave a scrollWidth a hair over.
      const overflowing = this.list.scrollWidth - this.list.clientWidth > 1;
      this.classList.toggle('nav-scroller--overflowing', overflowing);

      if (!overflowing) {
        if (this.prev) this.prev.disabled = true;
        if (this.next) this.next.disabled = true;
        return;
      }

      const start = this.list.scrollLeft;
      const end = this.list.scrollWidth - this.list.clientWidth;
      if (this.prev) this.prev.disabled = start <= 1;
      if (this.next) this.next.disabled = start >= end - 1;
    }
  }

  customElements.define('nav-scroller', NavScroller);
}

/*
  Closes an open menu card the way the cart and search cards close: on its own
  close button, on Escape, and on a click outside it. header-menu (Dawn) already
  handles Escape and outside clicks for its own markup, so this only adds the
  button, which is new to this panel.
*/
document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-menu-close]');
  if (!close) return;
  const details = close.closest('details');
  if (!details) return;
  details.removeAttribute('open');
  const summary = details.querySelector('summary');
  if (summary) {
    summary.setAttribute('aria-expanded', 'false');
    summary.focus();
  }
});

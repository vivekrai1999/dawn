/*
  <reviews-marquee> — progressive enhancement for snippets/reviews-marquee-row.liquid.

  The marquee itself is CSS: assets/component-review-marquee.css animates a track
  that holds repeated copies of one card group. This script never touches
  `transform` and never runs a per-frame loop to move anything. It does three
  jobs the stylesheet cannot:

    1. Measurement. A group's real width is only known at runtime (fonts, card
       count, viewport). The script measures it, appends copies until the track
       covers the row twice over — so no blank ever reaches the visible area —
       and writes the exact repeat distance and duration back as custom
       properties.
    2. A smooth pause. CSS can only stop an animation dead. Here the row's
       playback rate is eased to zero over a fraction of a second and back up
       again on leave, which is the only place a rAF loop runs, and only for the
       length of the ramp.
    3. State: per-row hover and touch handling, the Theme Editor, reduced
       motion, and idling the animation while the section is off-screen.

  Nothing is written to window, and every instance resolves its nodes from
  `this`, so any number of these sections can share a page. If this file never
  loads, the CSS still loops at the speed Liquid estimated.
*/
if (!customElements.get('reviews-marquee')) {
  /* How long a row takes to ease to a stop, and back up to speed. */
  const RAMP_DURATION = 320;

  /* Ease-out cubic: most of the speed is shed early, so a stop reads as
     deliberate rather than as a stall. */
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  /*
    One scrolling row: its clones, its measurements and its playback rate.

    Kept as a plain class rather than a second custom element because a row is
    never addressed from outside — the section owns it — and because this keeps
    all of the animation logic in one readable place.
  */
  class MarqueeRow {
    /**
     * @param {HTMLElement} row     The .review-marquee__row element.
     * @param {number} defaultSpeed Fallback scroll speed in px/s.
     */
    constructor(row, defaultSpeed) {
      this.row = row;
      this.track = row.querySelector('[data-marquee-track]');
      this.original = this.track && this.track.querySelector('[data-marquee-group]');
      this.speed = parseFloat(row.dataset.marqueeSpeed) || defaultSpeed;

      this.hovered = false;
      this.rampFrame = null;
      this.groupWidth = 0;
    }

    get usable() {
      return Boolean(this.track && this.original);
    }

    /*
      The CSSAnimation object for the looping keyframes. Resolved lazily: the
      animation does not exist until the element has been styled, and it is
      replaced whenever the animation is cancelled and restarted.
    */
    get animation() {
      if (!this.track || typeof this.track.getAnimations !== 'function') return null;
      return this.track.getAnimations().find((animation) => animation.playState !== 'finished') || null;
    }

    /*
      Sizes the loop. One group width is the repeat distance — the track slides
      exactly that far and snaps back to a frame that looks identical — and the
      duration follows from the merchant's speed so that cards travel at the same
      px/s whether there are three reviews or thirty.
    */
    measure() {
      if (!this.usable) return;

      const groupWidth = this.original.getBoundingClientRect().width;
      const rowWidth = this.row.getBoundingClientRect().width;
      if (groupWidth <= 0 || rowWidth <= 0) return;

      this.fill(groupWidth, rowWidth);

      const duration = groupWidth / Math.max(this.speed, 1);
      const previous = this.groupWidth;
      this.groupWidth = groupWidth;

      /* Re-measuring mid-cycle (a resize, a font swap) changes the duration under
         a running animation, which would otherwise teleport the track. Carrying
         the progress across keeps the row exactly where it was. */
      const animation = this.animation;
      const progress =
        animation && previous > 0 && animation.effect
          ? (animation.currentTime || 0) / animation.effect.getTiming().duration
          : null;

      this.row.style.setProperty('--review-marquee-shift', `${groupWidth}px`);
      this.row.style.setProperty('--review-marquee-duration', `${duration}s`);

      if (progress !== null && animation.effect) {
        animation.currentTime = (progress % 1) * duration * 1000;
      }
    }

    /*
      Guarantees the track is at least one full row wider than the distance it
      travels, so the moment the loop restarts there is already a card occupying
      every pixel of the visible area. Two copies are enough whenever the cards
      overflow the row; a short list on a wide screen needs more.
    */
    fill(groupWidth, rowWidth) {
      const needed = Math.max(2, Math.ceil(rowWidth / groupWidth) + 1);
      const groups = this.track.querySelectorAll('[data-marquee-group]');

      for (let index = groups.length; index < needed; index += 1) {
        this.track.appendChild(this.cloneGroup());
      }

      /* A viewport that got narrower leaves copies that are no longer earning
         their keep — and every one of them is real DOM to lay out. */
      for (let index = groups.length - 1; index >= needed; index -= 1) {
        groups[index].remove();
      }
    }

    cloneGroup() {
      const clone = this.original.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      clone.setAttribute('data-marquee-clone', '');

      /* A clone must not present itself to the Theme Editor as the block it was
         copied from, or selecting that block would match several elements. */
      clone.querySelectorAll('[data-shopify-editor-block]').forEach((node) => {
        node.removeAttribute('data-shopify-editor-block');
      });

      return clone;
    }

    /*
      Eases the row's playback rate toward `target` (1 = full speed, 0 = stopped).
      This is the only rAF loop in the file and it lives exactly as long as the
      ramp: nothing is scheduled while the row is simply running.
    */
    rampTo(target) {
      const animation = this.animation;

      if (!animation) {
        /* No Web Animations support: fall back to the stylesheet's hard pause,
           which is worse-looking but not broken. */
        this.row.classList.toggle('review-marquee__row--paused', target === 0);
        return;
      }

      if (this.rampFrame) cancelAnimationFrame(this.rampFrame);

      const from = animation.playbackRate;
      if (from === target) return;

      const start = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - start) / RAMP_DURATION);
        animation.playbackRate = from + (target - from) * ease(progress);

        if (progress < 1) {
          this.rampFrame = requestAnimationFrame(step);
        } else {
          this.rampFrame = null;
          animation.playbackRate = target;
        }
      };

      this.rampFrame = requestAnimationFrame(step);
    }

    /* Off-screen or reduced motion: stop outright rather than ease — there is no
       transition to smooth over when nobody is looking. */
    setRunning(running) {
      const animation = this.animation;
      if (!animation) return;

      if (this.rampFrame) {
        cancelAnimationFrame(this.rampFrame);
        this.rampFrame = null;
      }

      if (running) animation.play();
      else animation.pause();
    }

    destroy() {
      if (this.rampFrame) cancelAnimationFrame(this.rampFrame);
      this.rampFrame = null;
    }
  }

  class ReviewsMarquee extends HTMLElement {
    connectedCallback() {
      if (this.rows) return;

      this.autoplay = this.dataset.autoplay !== 'false';
      this.pauseOnHover = this.dataset.pauseOnHover !== 'false';
      this.defaultSpeed = parseFloat(this.dataset.speed) || 40;

      this.rows = Array.from(this.querySelectorAll('[data-marquee-row]'))
        .map((row) => new MarqueeRow(row, this.defaultSpeed))
        .filter((row) => row.usable);

      if (!this.rows.length) {
        this.rows = null;
        return;
      }

      this.editorPaused = false;
      this.visible = true;

      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.onMotionChange = this.handleMotionChange.bind(this);
      this.addMediaListener(this.motionQuery, this.onMotionChange);

      /* Tells the stylesheet to stand down: from here the pause is this script's
         to run, smoothly, rather than CSS's to run abruptly. */
      this.classList.add('review-marquee--enhanced');

      this.setupObservers();
      this.bindRowEvents();
      this.bindEditorEvents();

      this.refresh();
    }

    disconnectedCallback() {
      if (!this.rows) return;

      this.rows.forEach((row) => row.destroy());
      this.resizeObserver?.disconnect();
      this.intersectionObserver?.disconnect();
      this.removeMediaListener(this.motionQuery, this.onMotionChange);
      this.rows = null;
    }

    get reducedMotion() {
      return this.motionQuery.matches;
    }

    /* The animation only exists when the section is meant to move at all. */
    get animated() {
      return this.autoplay && !this.reducedMotion;
    }

    // ------------------------------------------------------------ Measurement

    refresh() {
      if (!this.animated) return;
      this.rows.forEach((row) => row.measure());
      this.applyMotion();
    }

    setupObservers() {
      if ('ResizeObserver' in window) {
        /* One observer for the whole section: a row's group width only changes
           when the section's box does. */
        this.resizeObserver = new ResizeObserver(() => {
          if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
          /* Coalesce the burst of callbacks a drag-resize produces into one
             measurement per frame. */
          this.resizeFrame = requestAnimationFrame(() => this.refresh());
        });
        this.resizeObserver.observe(this);
      } else {
        window.addEventListener('resize', () => this.refresh());
      }

      if ('IntersectionObserver' in window) {
        /* An animation nobody can see is pure battery cost. */
        this.intersectionObserver = new IntersectionObserver(
          (entries) => {
            this.visible = entries.some((entry) => entry.isIntersecting);
            this.applyMotion();
          },
          { rootMargin: '200px 0px' }
        );
        this.intersectionObserver.observe(this);
      }

      /* A late webfont changes every card's width, and with it the repeat
         distance. Re-measuring once it lands avoids a permanent seam. */
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => this.refresh()).catch(() => {});
      }
    }

    // ------------------------------------------------------------------ State

    /*
      The single place that decides what each row should be doing. Every input —
      hover, visibility, the Theme Editor, reduced motion — sets a flag and calls
      this, so the states can never disagree.
    */
    applyMotion() {
      if (!this.animated) return;

      const running = this.visible && !this.editorPaused;

      this.rows.forEach((row) => {
        row.setRunning(this.visible);
        if (!this.visible) return;
        row.rampTo(running && !row.hovered ? 1 : 0);
      });
    }

    handleMotionChange() {
      /* Reduced motion is handled by the stylesheet; all this has to do is stop
         driving an animation that no longer exists, or start driving one that
         has just come back. */
      this.refresh();
    }

    // ------------------------------------------------------------ Interaction

    bindRowEvents() {
      if (!this.pauseOnHover) return;

      this.rows.forEach((row) => {
        const setHovered = (hovered) => {
          if (row.hovered === hovered) return;
          row.hovered = hovered;
          this.applyMotion();
        };

        /* Mouse: hovering anywhere in the row — including over a card — pauses
           that row and leaves its neighbour running. */
        row.row.addEventListener('pointerenter', (event) => {
          if (event.pointerType === 'mouse') setHovered(true);
        });
        row.row.addEventListener('pointerleave', (event) => {
          if (event.pointerType === 'mouse') setHovered(false);
        });

        /* Touch and pen have no hover, so a press-and-hold stands in for it:
           hold a card to read it, lift to let the row go again. */
        row.row.addEventListener('pointerdown', (event) => {
          if (event.pointerType !== 'mouse') setHovered(true);
        });
        ['pointerup', 'pointercancel'].forEach((type) => {
          row.row.addEventListener(type, (event) => {
            if (event.pointerType !== 'mouse') setHovered(false);
          });
        });

        /* Keyboard: if a card ever gains focusable content, tabbing into it must
           not leave the reader chasing a moving target. */
        row.row.addEventListener('focusin', () => setHovered(true));
        row.row.addEventListener('focusout', () => setHovered(false));
      });
    }

    bindEditorEvents() {
      /* Selecting a review in the Theme Editor should hold it still so the
         merchant can see what they are editing. */
      this.addEventListener('shopify:block:select', () => {
        this.editorPaused = true;
        this.applyMotion();
      });

      this.addEventListener('shopify:block:deselect', () => {
        this.editorPaused = false;
        this.applyMotion();
      });
    }

    // ----------------------------------------------------------------- Helpers

    /* Safari below 14 only has the deprecated listener API. */
    addMediaListener(query, handler) {
      if (query.addEventListener) query.addEventListener('change', handler);
      else query.addListener(handler);
    }

    removeMediaListener(query, handler) {
      if (query.removeEventListener) query.removeEventListener('change', handler);
      else query.removeListener(handler);
    }
  }

  customElements.define('reviews-marquee', ReviewsMarquee);
}

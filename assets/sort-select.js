/*
  <sort-select> — a styled dropdown for the collection/search sort control.

  A native <select> cannot have its option list styled, so the list is rendered
  as markup and the native control is kept in the form, visually hidden. Choosing
  an option writes the value back to that <select> and fires the `input` event
  that Dawn's FacetFiltersForm already listens for, so sorting keeps working
  through Dawn's own code path — including history, the loading state and the
  no-JS fallback, since without this script the plain <select> is still there.

  Progressive enhancement: the custom UI is only revealed once this element
  upgrades, so a visitor without JS gets the normal select rather than a dead
  trigger.
*/
if (!customElements.get('sort-select')) {
  class SortSelect extends HTMLElement {
    connectedCallback() {
      if (this.initialized) return;

      this.select = this.querySelector('select');
      this.details = this.querySelector('[data-sort-details]');
      this.label = this.querySelector('[data-sort-label]');
      this.options = Array.from(this.querySelectorAll('[data-sort-option]'));
      if (!this.select || !this.details || !this.options.length) return;

      this.initialized = true;
      // Hands presentation to the custom UI now that it can actually work.
      this.classList.add('sort-select--ready');

      this.onDocumentClick = this.handleDocumentClick.bind(this);
      this.onKeydown = this.handleKeydown.bind(this);

      this.options.forEach((option) => {
        option.addEventListener('click', this.handleSelect.bind(this));
      });
      this.details.addEventListener('toggle', this.handleToggle.bind(this));
      this.addEventListener('keydown', this.onKeydown);
      // Keeps the trigger honest if anything else changes the value.
      this.select.addEventListener('change', this.syncFromSelect.bind(this));

      this.syncFromSelect();
    }

    disconnectedCallback() {
      document.removeEventListener('click', this.onDocumentClick);
      this.initialized = false;
    }

    handleToggle() {
      if (this.details.open) {
        document.addEventListener('click', this.onDocumentClick);
      } else {
        document.removeEventListener('click', this.onDocumentClick);
      }
    }

    handleDocumentClick(event) {
      if (!this.contains(event.target)) this.close();
    }

    handleKeydown(event) {
      if (event.key !== 'Escape' || !this.details.open) return;
      this.close();
      const summary = this.details.querySelector('summary');
      if (summary) summary.focus();
    }

    handleSelect(event) {
      const value = event.currentTarget.dataset.sortOption;
      if (value == null) return;

      this.select.value = value;
      this.syncFromSelect();
      this.close();

      /*
        Dawn binds its debounced submit to `input` on the form, so dispatching it
        from the real select drives the same refresh a native change would. It
        must bubble to reach the form.
      */
      this.select.dispatchEvent(new Event('input', { bubbles: true }));
      this.select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /* Mirrors the select's current value onto the trigger and the option list. */
    syncFromSelect() {
      const current = this.select.value;
      const selected = this.select.options[this.select.selectedIndex];
      if (this.label && selected) this.label.textContent = selected.textContent.trim();

      this.options.forEach((option) => {
        const isCurrent = option.dataset.sortOption === current;
        option.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
        option.classList.toggle('sort-select__option--active', isCurrent);
      });
    }

    close() {
      this.details.open = false;
    }
  }

  customElements.define('sort-select', SortSelect);
}

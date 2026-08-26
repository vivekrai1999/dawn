/**
 * <variant-picker> — modular, data-driven variant picker.
 *
 * Responsibilities:
 *  - Selection state (one value per option position)
 *  - Client-side variant resolution from embedded product variant data
 *  - Instant combination-aware availability feedback
 *  - Hidden product-form variant ID sync
 *  - Publishing optionValueSelectionChange so product-info.js keeps owning
 *    price/media/quantity-rules/URL updates via its section re-render flow
 *  - ProductSelectEvent deferred-API parity consumed by product-info.js
 */
if (!customElements.get('variant-picker')) {
  const publishSafe = (eventName, payload) => {
    if (typeof publish !== 'function' || typeof PUB_SUB_EVENTS === 'undefined') return;
    if (!PUB_SUB_EVENTS[eventName]) return;
    publish(PUB_SUB_EVENTS[eventName], payload);
  };

  class VariantPicker extends HTMLElement {
    constructor() {
      super();
      this.handleChange = this.handleChange.bind(this);
      this.pendingSelectDeferred = null;
    }

    connectedCallback() {
      this.variants = this.parseVariants();
      this.variantIndex = new Map(this.variants.map((variant) => [this.keyFor(variant.options), variant]));
      this.addEventListener('change', this.handleChange);
      // Server-rendered inputs already carry the initial selection; align the
      // availability UI immediately instead of waiting for the first change.
      this.updateAvailability();
    }

    disconnectedCallback() {
      this.removeEventListener('change', this.handleChange);
    }

    /* ------------------------------ Data ------------------------------ */

    parseVariants() {
      try {
        const script = this.querySelector('[data-variant-data]');
        return JSON.parse(script.textContent).variants || [];
      } catch {
        return [];
      }
    }

    keyFor(optionTitles) {
      return optionTitles.join('||');
    }

    /* --------------------------- Selection ---------------------------- */

    getGroups() {
      return Array.from(this.querySelectorAll('[data-option-position]'));
    }

    getGroupValue(group) {
      const checked = group.querySelector('input[type="radio"]:checked');
      if (checked) return checked.value;
      const select = group.querySelector('select');
      return select ? select.value : null;
    }

    getSelectedOptions() {
      return this.getGroups().map((group) => this.getGroupValue(group));
    }

    resolveVariant(optionTitles) {
      if (!optionTitles || optionTitles.some((title) => title == null)) return null;
      return this.variantIndex.get(this.keyFor(optionTitles)) || null;
    }

    get selectedOptionValues() {
      return Array.from(this.querySelectorAll('select option[selected], fieldset input:checked')).map(
        (element) => element.dataset.optionValueId
      );
    }

    getAllSelectedOptions() {
      return Array.from(this.querySelectorAll('[data-option-position]')).map((group) => {
        const control = group.querySelector('input:checked') || group.querySelector('select option[selected]');
        return { name: control?.dataset.optionName || '', value: control?.value || '' };
      });
    }

    /* -------------------------- Availability -------------------------- */

    matchesPattern(variant, pattern) {
      return pattern.every((title, index) => title == null || variant.options[index] === title);
    }

    updateAvailability() {
      const groups = this.getGroups();
      const selections = groups.map((group) => this.getGroupValue(group));

      groups.forEach((group, index) => {
        const pattern = selections.slice();
        pattern[index] = null;

        group.querySelectorAll('input[type="radio"]').forEach((input) => {
          pattern[index] = input.value;
          const isSelectable = this.variants.some(
            (variant) => this.matchesPattern(variant, pattern) && variant.available
          );
          if (isSelectable) {
            input.removeAttribute('data-unavailable');
          } else {
            input.setAttribute('data-unavailable', '');
          }
        });
      });

      return selections;
    }

    /* ------------------------- DOM + form sync ------------------------ */

    updateSelectionMetadata(changedControl) {
      const group = changedControl.closest('[data-option-position]');
      if (!group) return;

      const selectedValue = group.querySelector('[data-selected-value]');
      if (selectedValue && changedControl.tagName !== 'SELECT') {
        selectedValue.textContent = changedControl.value;
      }

      if (changedControl.tagName === 'SELECT') {
        Array.from(changedControl.options).forEach((option) => option.toggleAttribute('selected', option.selected));

        const swatchDot = group.querySelector('[data-selected-swatch]');
        if (swatchDot) {
          const swatchValue = changedControl.selectedOptions[0]?.dataset.swatchValue;
          if (swatchValue) {
            swatchDot.style.setProperty('--vp-swatch-background', swatchValue);
            swatchDot.classList.remove('variant-picker__swatch--fallback');
          } else {
            swatchDot.style.setProperty('--vp-swatch-background', 'unset');
            swatchDot.classList.add('variant-picker__swatch--fallback');
          }
        }
      }
    }

    syncHiddenInput(variant) {
      const sectionId = this.dataset.section;
      document
        .querySelectorAll(`#product-form-${sectionId}, #product-form-installment-${sectionId}`)
        .forEach((formContainer) => {
          const input = formContainer.querySelector('input[name="id"]');
          if (!input || input.value === String(variant?.id ?? '')) return;
          input.value = variant?.id ?? '';
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    /* ------------------------ Event integration ----------------------- */

    handleChange(event) {
      const target = event.target instanceof HTMLOptionElement ? event.target.closest('select') : event.target;
      if (!target || !this.contains(target)) return;

      const metadataTarget = target.tagName === 'SELECT' ? target.selectedOptions[0] : target;

      this.updateSelectionMetadata(target);
      this.dispatchProductSelectEvent();

      const selections = this.getSelectedOptions();
      const variant = this.resolveVariant(selections);

      this.updateAvailability();
      this.syncHiddenInput(variant);

      publishSafe('optionValueSelectionChange', {
        data: {
          event,
          target: metadataTarget,
          selectedOptionValues: this.selectedOptionValues,
        },
      });
    }

    dispatchProductSelectEvent() {
      const { ProductSelectEvent } = window.StandardEvents || {};
      if (!ProductSelectEvent) return;

      const deferred = ProductSelectEvent.createPromise();
      this.pendingSelectDeferred = deferred;

      this.dispatchEvent(
        new ProductSelectEvent({
          product: {
            id: this.dataset.productId,
            title: this.dataset.productTitle,
            handle: this.dataset.productHandle,
          },
          selectedOptions: this.getAllSelectedOptions(),
          promise: deferred.promise,
        })
      );
    }

    takePendingSelectDeferred() {
      const deferred = this.pendingSelectDeferred;
      this.pendingSelectDeferred = null;
      return deferred;
    }

    resolvePendingSelectPromise(variant, sourcePicker = this) {
      const deferred = this.takePendingSelectDeferred();
      if (!deferred) return;

      if (variant) {
        deferred.resolve({
          variant: {
            id: variant.id,
            title: variant.title,
            availableForSale: variant.available,
            price: {
              amount: sourcePicker?.dataset.selectedPriceAmount,
              currencyCode: sourcePicker?.dataset.currencyCode,
            },
            selectedOptions: this.getAllSelectedOptions(),
          },
        });
      } else {
        deferred.resolve({ variant: null });
      }
    }

    rejectPendingSelectPromise(error) {
      this.takePendingSelectDeferred()?.reject(error);
    }

    parseJsonScript(parent, selector) {
      try {
        return JSON.parse(parent?.querySelector(selector)?.textContent);
      } catch {
        return null;
      }
    }

    getSelectedVariant(queryRoot = this) {
      return this.parseJsonScript(queryRoot, '[data-selected-variant]');
    }
  }

  customElements.define('variant-picker', VariantPicker);
}

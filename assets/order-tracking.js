/*
  <order-tracking> — carrier switching for sections/order-tracking.liquid.

  The form is already addressed to a real carrier when it arrives: the section
  renders its action and its field name from the first carrier server-side. All
  this does is re-address it when a different carrier is chosen, so the page
  works with no JavaScript — it just submits to whichever carrier was first.

  Follows the same contract as the theme's other custom elements: nodes are
  resolved from `this`, nothing is written to window, and the listener is
  released in disconnectedCallback so the Theme Editor's re-render is handled.
*/
if (!customElements.get('order-tracking')) {
  class OrderTracking extends HTMLElement {
    connectedCallback() {
      this.form = this.querySelector('[data-tracking-form]');
      this.carrier = this.querySelector('[data-tracking-carrier]');
      this.number = this.querySelector('[data-tracking-number]');

      if (!this.form || !this.carrier || !this.number) return;

      this.onChange = this.handleChange.bind(this);
      this.carrier.addEventListener('change', this.onChange);
    }

    disconnectedCallback() {
      if (this.carrier && this.onChange) {
        this.carrier.removeEventListener('change', this.onChange);
      }
    }

    /*
      Each carrier expects the number under its own query parameter, so the
      field is renamed along with the destination. Renaming rather than adding
      keeps exactly one number in the query string.
    */
    handleChange() {
      const option = this.carrier.options[this.carrier.selectedIndex];
      if (!option) return;

      const action = option.value;
      const parameter = option.dataset.parameter;

      if (action) this.form.setAttribute('action', action);
      if (parameter) this.number.setAttribute('name', parameter);
    }
  }

  customElements.define('order-tracking', OrderTracking);
}

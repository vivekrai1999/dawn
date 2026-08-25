(function() {
  if (window.__floatingActionsFormInitialized) return;
  window.__floatingActionsFormInitialized = true;

  function openModal(modal) {
    if (!modal) return;
    if (typeof modal.showModal === 'function') {
      if (!modal.open) modal.showModal();
    } else {
      modal.setAttribute('open', '');
    }
  }

  function closeModal(modal) {
    if (!modal) return;
    if (typeof modal.close === 'function') {
      modal.close();
    } else {
      modal.removeAttribute('open');
    }
  }

  document.addEventListener('click', function(event) {
    const openBtn = event.target.closest('[data-fab-open-form]');
    if (openBtn) {
      event.preventDefault();
      openModal(document.getElementById('FloatingFormModal-' + openBtn.dataset.sectionId));
      return;
    }

    // Any link pointing at #floating-form (footer menu, inline text links)
    // opens the first floating form modal on the page.
    const hashLink = event.target.closest('a[href$="#floating-form"]');
    if (hashLink) {
      event.preventDefault();
      openModal(document.querySelector('dialog.floating-form-modal'));
      return;
    }

    const closeBtn = event.target.closest('[data-fab-close-form]');
    if (closeBtn) {
      event.preventDefault();
      closeModal(closeBtn.closest('dialog'));
      return;
    }

    if (event.target.tagName === 'DIALOG' && event.target.classList.contains('floating-form-modal')) {
      const rect = event.target.getBoundingClientRect();
      const isInDialog = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (!isInDialog) closeModal(event.target);
    }
  });

  /*
    Contact forms are submitted with fetch: Shopify answers with a redirect to
    the same page, and the re-rendered form carries the success/error status.
    Swapping it in keeps the shopper exactly where they are — no page reload,
    so nothing to re-open later.
  */
  document.addEventListener('submit', function(event) {
    const form = event.target.closest('.floating-form');
    if (!form || !window.fetch || form.dataset.fabSubmitting === 'true') return;

    event.preventDefault();

    const button = form.querySelector('.floating-form__submit');
    if (button) {
      button.disabled = true;
      button.dataset.fabLabel = button.textContent;
      button.textContent = '…';
    }
    form.dataset.fabSubmitting = 'true';

    fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'text/html' },
    })
      .then(function(response) {
        if (!response.ok) throw new Error(response.status);
        return response.text();
      })
      .then(function(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const nextForm = doc.querySelector('form.floating-form');
        // The re-rendered form holds the success/error status; without it the
        // answer did not come back usable — let a plain reload show it.
        if (!nextForm) throw new Error('no form in response');

        form.innerHTML = nextForm.innerHTML;
        delete form.dataset.fabSubmitting;
        const status = form.querySelector('.floating-form__status');
        if (status) status.focus();
      })
      .catch(function() {
        // Fall back to the browser submit so the message still arrives.
        form.dataset.fabSubmitting = 'false';
        if (button) button.disabled = false;
        form.submit();
      });
  });
})();
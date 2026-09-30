// Stripe Payment Element checkout for the Valora platform fee.
// The browser ONLY collects card details and handles 3-D Secure actions.
// Payment confirmation happens server-side; the secret key never leaves the server.

(function () {
  var el = document.getElementById('pay-data');
  if (!el || typeof Stripe === 'undefined') return;

  var stripe = Stripe(el.dataset.publishableKey);
  var elements = stripe.elements({ clientSecret: el.dataset.clientSecret });
  var paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');

  var form = document.getElementById('payment-form');
  var submitBtn = document.getElementById('submit-btn');
  var messageBox = document.getElementById('payment-message');
  var tradeId = el.dataset.tradeId;
  var csrfToken = el.dataset.csrf;
  var busy = false;

  function showMessage(msg) {
    messageBox.textContent = msg;
    messageBox.style.display = 'block';
  }

  function setBusy(on, label) {
    busy = on;
    submitBtn.disabled = on;
    submitBtn.textContent = label || 'Pay';
  }

  async function postJson(url, data) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(data),
    });
    var body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    return { status: res.status, body: body || {} };
  }

  function done(ok) {
    window.location.href = '/trades/' + encodeURIComponent(tradeId) + '/pay/result';
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true, 'Processing…');
    messageBox.style.display = 'none';

    try {
      // 1. Validate + collect the payment method in the browser.
      var pmResult = await stripe.createPaymentMethod({ elements: elements });
      if (pmResult.error) {
        throw new Error(pmResult.error.message || 'Could not read your card details.');
      }

      // 2. The server confirms the PaymentIntent.
      var confirm = await postJson('/trades/' + encodeURIComponent(tradeId) + '/pay/confirm', {
        _csrf: csrfToken,
        payment_method: pmResult.paymentMethod.id,
      });
      if (confirm.body.ok) {
        done(true);
        return;
      }
      if (confirm.body.requires_action && confirm.body.client_secret) {
        // 3. 3-D Secure (or similar): complete in the browser, then the
        //    server re-verifies the final outcome.
        var action = await stripe.handleNextAction({ clientSecret: confirm.body.client_secret });
        if (action.error) {
          throw new Error(action.error.message || 'Authentication failed.');
        }
        var fin = await postJson('/trades/' + encodeURIComponent(tradeId) + '/pay/finalize', {
          _csrf: csrfToken,
        });
        if (fin.body.ok) {
          done(true);
          return;
        }
        throw new Error(fin.body.error || 'The payment did not go through.');
      }
      throw new Error(confirm.body.error || 'Payment failed. Please try again.');
    } catch (err) {
      showMessage((err && err.message) || 'Payment failed. Please try again.');
      setBusy(false, 'Pay');
    }
  });
})();

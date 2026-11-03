/* PageZaper Pay on the block checkout: registers the payment method. No
 * build step — plain wp.element. Payment itself happens on the order-pay
 * page the gateway redirects to. */
(function () {
  'use strict';
  var registry = window.wc && window.wc.wcBlocksRegistry;
  var getSetting = window.wc && window.wc.wcSettings && window.wc.wcSettings.getSetting;
  var el = window.wp && window.wp.element && window.wp.element.createElement;
  var decode = window.wp && window.wp.htmlEntities ? window.wp.htmlEntities.decodeEntities : function (s) { return s; };
  if (!registry || !getSetting || !el) return;

  var data = getSetting('pagezaper_pay_data', {});
  var title = decode(data.title || 'UPI, cards, net banking & wallets');
  var Content = function () { return el('div', null, decode(data.description || '')); };

  registry.registerPaymentMethod({
    name: 'pagezaper_pay',
    label: el('span', null, title),
    ariaLabel: title,
    content: el(Content),
    edit: el(Content),
    canMakePayment: function () { return true; },
    supports: { features: data.supports || ['products'] },
  });
})();

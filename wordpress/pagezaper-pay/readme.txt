=== PageZaper Pay ===
Contributors: pagezaper
Tags: woocommerce, razorpay, upi, payments, india
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Take UPI, card, net banking and wallet payments on WooCommerce through PageZaper and Razorpay, with automatic payouts to your bank.

== Description ==

PageZaper Pay adds a payment option to your WooCommerce checkout. Buyers pay on Razorpay's secure checkout; each sale is split automatically with Razorpay Route — your share is paid out to the bank account you verified in PageZaper, and PageZaper's fee is kept by PageZaper.

An order is only marked paid after PageZaper confirms the payment with Razorpay directly. Nothing the buyer's browser says about a payment is trusted.

== Installation ==

1. In PageZaper, open Settings → Payouts and verify your business with Razorpay.
2. Under Connected WordPress sites, enter this site's address and press Create API key. Copy the key.
3. Upload and activate this plugin in WordPress (Plugins → Add New → Upload Plugin).
4. Go to WooCommerce → Settings → Payments → PageZaper Pay, enable it and paste your key.

Your store currency must be Indian Rupees (INR).

== Frequently Asked Questions ==

= When do I get paid? =
Once Razorpay captures a payment, your share is transferred to your linked account and settled to your bank on Razorpay's normal schedule.

= Why don't buyers see PageZaper Pay at checkout? =
Check that it's enabled, an API key is saved, and your store currency is INR. The notices at the top of your WordPress admin say what's missing.

== Changelog ==

= 1.0.0 =
* First release.

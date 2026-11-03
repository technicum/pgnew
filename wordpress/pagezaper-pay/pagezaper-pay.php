<?php
/**
 * Plugin Name:       PageZaper Pay
 * Plugin URI:        https://pagezaper.com/woocommerce
 * Description:       Take payments on WooCommerce through PageZaper and Razorpay. Each sale is split automatically: your share is paid out to your bank, PageZaper's fee is kept by PageZaper.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Requires Plugins:  woocommerce
 * Author:            PageZaper
 * Author URI:        https://pagezaper.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       pagezaper-pay
 * WC requires at least: 7.0
 * WC tested up to:   9.4
 *
 * @package PageZaperPay
 */

defined( 'ABSPATH' ) || exit;

define( 'PAGEZAPER_PAY_VERSION', '1.0.0' );
define( 'PAGEZAPER_PAY_FILE', __FILE__ );
define( 'PAGEZAPER_PAY_DIR', plugin_dir_path( __FILE__ ) );
define( 'PAGEZAPER_PAY_URL', plugin_dir_url( __FILE__ ) );

/**
 * Works with WooCommerce's custom order tables (HPOS) and block checkout.
 */
add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', PAGEZAPER_PAY_FILE, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', PAGEZAPER_PAY_FILE, true );
		}
	}
);

/**
 * Loads the gateway once WooCommerce is there; otherwise says so.
 */
function pagezaper_pay_init() {
	if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
		add_action( 'admin_notices', 'pagezaper_pay_notice_no_woocommerce' );
		return;
	}
	require_once PAGEZAPER_PAY_DIR . 'includes/class-pagezaper-pay-api.php';
	require_once PAGEZAPER_PAY_DIR . 'includes/class-pagezaper-pay-gateway.php';

	add_filter(
		'woocommerce_payment_gateways',
		function ( $gateways ) {
			$gateways[] = 'PageZaper_Pay_Gateway';
			return $gateways;
		}
	);
	add_filter( 'plugin_action_links_' . plugin_basename( PAGEZAPER_PAY_FILE ), 'pagezaper_pay_action_links' );
	add_action( 'admin_notices', 'pagezaper_pay_admin_notices' );
}
add_action( 'plugins_loaded', 'pagezaper_pay_init' );

/**
 * Block checkout support.
 */
add_action(
	'woocommerce_blocks_loaded',
	function () {
		if ( ! class_exists( '\Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType' ) ) {
			return;
		}
		require_once PAGEZAPER_PAY_DIR . 'includes/class-pagezaper-pay-blocks.php';
		add_action(
			'woocommerce_blocks_payment_method_type_registration',
			function ( $registry ) {
				$registry->register( new PageZaper_Pay_Blocks() );
			}
		);
	}
);

/**
 * The plugin's Settings link on the Plugins screen.
 *
 * @param array $links Existing links.
 * @return array
 */
function pagezaper_pay_action_links( $links ) {
	$url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=pagezaper_pay' );
	array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'pagezaper-pay' ) . '</a>' );
	return $links;
}

/**
 * WooCommerce isn't active.
 */
function pagezaper_pay_notice_no_woocommerce() {
	if ( ! current_user_can( 'activate_plugins' ) ) {
		return;
	}
	echo '<div class="notice notice-error"><p><strong>' . esc_html__( 'PageZaper Pay', 'pagezaper-pay' ) . '</strong> ' .
		esc_html__( 'needs WooCommerce. Install and activate WooCommerce to take payments through PageZaper.', 'pagezaper-pay' ) . '</p></div>';
}

/**
 * Clear notices for store managers about what's stopping payments: no API
 * key, a currency PageZaper can't take, payouts not active yet (as the API
 * last reported), or test mode.
 */
function pagezaper_pay_admin_notices() {
	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		return;
	}
	$settings = get_option( 'woocommerce_pagezaper_pay_settings', array() );
	$enabled  = isset( $settings['enabled'] ) && 'yes' === $settings['enabled'];
	$url      = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=pagezaper_pay' );
	$notices  = array();

	if ( empty( $settings['api_key'] ) ) {
		$notices[] = array(
			'warning',
			sprintf(
				/* translators: 1: settings link open, 2: link close */
				esc_html__( 'Add your PageZaper API key to start taking payments. Create one in PageZaper under Settings → Payouts, then paste it in %1$sPageZaper Pay settings%2$s.', 'pagezaper-pay' ),
				'<a href="' . esc_url( $url ) . '">',
				'</a>'
			),
		);
	} elseif ( $enabled && 'INR' !== get_woocommerce_currency() ) {
		$notices[] = array( 'error', esc_html__( 'PageZaper Pay only takes payments in Indian Rupees (INR). Change your store currency, or buyers won’t see it at checkout.', 'pagezaper-pay' ) );
	}

	$problem = get_option( 'pagezaper_pay_last_error', '' );
	if ( $enabled && 'payouts_not_active' === $problem ) {
		$notices[] = array( 'error', esc_html__( 'PageZaper can’t take payments for this store yet: your payout account isn’t active. Finish Settings → Payouts in your PageZaper dashboard — Razorpay usually verifies it within a day or two.', 'pagezaper-pay' ) );
	} elseif ( $enabled && 'unauthorized' === $problem ) {
		$notices[] = array( 'error', esc_html__( 'PageZaper didn’t accept your API key — it may have been revoked. Create a new one in PageZaper under Settings → Payouts and paste it in PageZaper Pay settings.', 'pagezaper-pay' ) );
	}
	if ( $enabled && 'yes' === get_option( 'pagezaper_pay_test_mode', '' ) ) {
		$notices[] = array( 'info', esc_html__( 'PageZaper Pay is in test mode: buyers can pay with Razorpay test cards and no real money moves.', 'pagezaper-pay' ) );
	}

	foreach ( $notices as $notice ) {
		printf(
			'<div class="notice notice-%1$s"><p><strong>%2$s</strong> %3$s</p></div>',
			esc_attr( $notice[0] ),
			esc_html__( 'PageZaper Pay:', 'pagezaper-pay' ),
			wp_kses( $notice[1], array( 'a' => array( 'href' => array() ) ) )
		);
	}
}

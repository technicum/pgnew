<?php
/**
 * PageZaper Pay on WooCommerce's block checkout. Paying works the same as on
 * the classic checkout: process_payment() sends the buyer to the order-pay
 * page, which opens Razorpay.
 *
 * @package PageZaperPay
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

/**
 * Block checkout integration.
 */
final class PageZaper_Pay_Blocks extends AbstractPaymentMethodType {

	/**
	 * Matches the gateway id.
	 *
	 * @var string
	 */
	protected $name = 'pagezaper_pay';

	/**
	 * Loads the gateway's settings.
	 */
	public function initialize() {
		$this->settings = get_option( 'woocommerce_pagezaper_pay_settings', array() );
	}

	/**
	 * Shown when the gateway would be.
	 *
	 * @return bool
	 */
	public function is_active() {
		$gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : array();
		return isset( $gateways['pagezaper_pay'] ) && $gateways['pagezaper_pay']->is_available();
	}

	/**
	 * The script that registers the method with the checkout block.
	 *
	 * @return string[]
	 */
	public function get_payment_method_script_handles() {
		wp_register_script(
			'pagezaper-pay-blocks',
			PAGEZAPER_PAY_URL . 'assets/js/blocks.js',
			array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities' ),
			PAGEZAPER_PAY_VERSION,
			true
		);
		return array( 'pagezaper-pay-blocks' );
	}

	/**
	 * What the script gets.
	 *
	 * @return array
	 */
	public function get_payment_method_data() {
		return array(
			'title'       => $this->get_setting( 'title' ),
			'description' => $this->get_setting( 'description' ),
			'supports'    => array( 'products' ),
		);
	}
}

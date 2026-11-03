<?php
/**
 * The PageZaper Pay payment gateway.
 *
 * How a payment goes:
 *  1. process_payment() asks PageZaper for an order (POST /api/v1/wc/orders)
 *     and sends the buyer to WooCommerce's order-pay page.
 *  2. receipt_page() opens Razorpay's checkout there.
 *  3. Razorpay's success callback sends the buyer to our wc-api endpoint;
 *     separately, PageZaper nudges the same endpoint once the payment is in.
 *  4. Either way, handle_callback() never takes anyone's word for it: it asks
 *     PageZaper (GET /api/v1/wc/orders/:id), which itself re-checks with
 *     Razorpay, and only marks the order paid when PageZaper says paid for
 *     this order, at this amount.
 *
 * @package PageZaperPay
 */

defined( 'ABSPATH' ) || exit;

/**
 * PageZaper Pay.
 */
class PageZaper_Pay_Gateway extends WC_Payment_Gateway {

	const META_ID       = '_pagezaper_order_id';
	const META_RZP      = '_pagezaper_razorpay_order_id';
	const META_KEY_ID   = '_pagezaper_razorpay_key_id';
	const NONCE_ACTION  = 'pagezaper_pay_return_';
	const DEFAULT_BASE  = 'https://pagezaper.com';

	/**
	 * Constructor.
	 */
	public function __construct() {
		$this->id                 = 'pagezaper_pay';
		$this->has_fields         = false;
		$this->method_title       = __( 'PageZaper Pay', 'pagezaper-pay' );
		$this->method_description = __( 'Take UPI, card, net banking and wallet payments through PageZaper and Razorpay. Your share of each sale is paid out to the bank account in your PageZaper payout settings.', 'pagezaper-pay' );
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();

		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );
		$this->enabled     = $this->get_option( 'enabled' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_action( 'woocommerce_receipt_' . $this->id, array( $this, 'receipt_page' ) );
		add_action( 'woocommerce_api_' . $this->id, array( $this, 'handle_callback' ) );
	}

	/**
	 * The settings screen (WooCommerce → Settings → Payments → PageZaper Pay).
	 */
	public function init_form_fields() {
		$this->form_fields = array(
			'enabled'     => array(
				'title'   => __( 'Enable/Disable', 'pagezaper-pay' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable PageZaper Pay', 'pagezaper-pay' ),
				'default' => 'no',
			),
			'title'       => array(
				'title'       => __( 'Title', 'pagezaper-pay' ),
				'type'        => 'text',
				'description' => __( 'What buyers see at checkout.', 'pagezaper-pay' ),
				'default'     => __( 'UPI, cards, net banking & wallets', 'pagezaper-pay' ),
				'desc_tip'    => true,
			),
			'description' => array(
				'title'       => __( 'Description', 'pagezaper-pay' ),
				'type'        => 'textarea',
				'description' => __( 'Shown under the title at checkout.', 'pagezaper-pay' ),
				'default'     => __( 'Pay securely with Razorpay.', 'pagezaper-pay' ),
				'desc_tip'    => true,
			),
			'api_key'     => array(
				'title'       => __( 'PageZaper API key', 'pagezaper-pay' ),
				'type'        => 'password',
				'description' => __( 'Starts with pzwc_. Create one in your PageZaper dashboard under Settings → Payouts → Connected WordPress sites.', 'pagezaper-pay' ),
				'default'     => '',
			),
			'api_base'    => array(
				'title'       => __( 'PageZaper address', 'pagezaper-pay' ),
				'type'        => 'text',
				'description' => __( 'Leave as it is unless PageZaper support asks you to change it.', 'pagezaper-pay' ),
				'default'     => self::DEFAULT_BASE,
				'desc_tip'    => true,
			),
		);
	}

	/**
	 * Only a well-formed key is saved; a bad one keeps the old key and says so.
	 *
	 * @param string $key   Field key.
	 * @param string $value Posted value.
	 * @return string
	 */
	public function validate_api_key_field( $key, $value ) {
		$value = trim( sanitize_text_field( wp_unslash( (string) $value ) ) );
		if ( '' !== $value && ! preg_match( '/^pzwc_[0-9a-f]{40}$/', $value ) ) {
			WC_Admin_Settings::add_error( __( 'That PageZaper API key doesn’t look right. It starts with pzwc_ followed by 40 letters and numbers.', 'pagezaper-pay' ) );
			return $this->get_option( 'api_key' );
		}
		if ( $value !== $this->get_option( 'api_key' ) ) {
			delete_option( 'pagezaper_pay_last_error' );
		}
		return $value;
	}

	/**
	 * Only https addresses (http only for a local test install).
	 *
	 * @param string $key   Field key.
	 * @param string $value Posted value.
	 * @return string
	 */
	public function validate_api_base_field( $key, $value ) {
		$value = esc_url_raw( trim( wp_unslash( (string) $value ) ), array( 'https', 'http' ) );
		$host  = wp_parse_url( $value, PHP_URL_HOST );
		if ( ! $value || ( 0 !== strpos( $value, 'https://' ) && ! in_array( $host, array( 'localhost', '127.0.0.1' ), true ) ) ) {
			WC_Admin_Settings::add_error( __( 'The PageZaper address needs to start with https://.', 'pagezaper-pay' ) );
			return self::DEFAULT_BASE;
		}
		return untrailingslashit( $value );
	}

	/**
	 * Shown at checkout only with a key, in rupees.
	 *
	 * @return bool
	 */
	public function is_available() {
		return parent::is_available() && '' !== $this->get_option( 'api_key' ) && 'INR' === get_woocommerce_currency();
	}

	/**
	 * The API client.
	 *
	 * @return PageZaper_Pay_API
	 */
	private function api() {
		return new PageZaper_Pay_API( $this->get_option( 'api_key' ), $this->get_option( 'api_base', self::DEFAULT_BASE ) );
	}

	/**
	 * An order's total in paise.
	 *
	 * @param WC_Order $order Order.
	 * @return int
	 */
	private static function paise( $order ) {
		return (int) round( (float) $order->get_total() * 100 );
	}

	/**
	 * Creates the PageZaper order and sends the buyer on to pay.
	 *
	 * @param int $order_id WooCommerce order id.
	 * @return array
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return array( 'result' => 'failure' );
		}
		$body = array(
			'amount'      => self::paise( $order ),
			'currency'    => $order->get_currency(),
			'wc_order_id' => (string) $order->get_id(),
			'buyer'       => array(
				'name'  => trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() ),
				'email' => $order->get_billing_email(),
				'phone' => $order->get_billing_phone(),
			),
		);
		// PageZaper only nudges https addresses.
		$notify = WC()->api_request_url( $this->id );
		if ( 0 === strpos( $notify, 'https://' ) ) {
			$body['notify_url'] = $notify;
		}

		$result = $this->api()->create_order( $body );
		if ( is_wp_error( $result ) ) {
			$code = $result->get_error_code();
			if ( in_array( $code, array( 'payouts_not_active', 'unauthorized', 'account_unavailable' ), true ) ) {
				update_option( 'pagezaper_pay_last_error', $code, false );
			}
			if ( 'already_paid' === $code ) {
				// Paid already (a second click, say): confirm it the usual way.
				if ( $this->verify_and_complete( $order ) ) {
					return array( 'result' => 'success', 'redirect' => $this->get_return_url( $order ) );
				}
			}
			$order->add_order_note( sprintf( /* translators: %s: error */ __( 'PageZaper Pay couldn’t start the payment: %s', 'pagezaper-pay' ), $result->get_error_message() ) );
			wc_add_notice( __( 'We couldn’t start the payment just now. Please try again in a minute, or choose another payment method.', 'pagezaper-pay' ), 'error' );
			return array( 'result' => 'failure' );
		}
		if ( empty( $result['id'] ) || empty( $result['razorpay']['order_id'] ) || empty( $result['razorpay']['key_id'] ) ) {
			wc_add_notice( __( 'We couldn’t start the payment just now. Please try again.', 'pagezaper-pay' ), 'error' );
			return array( 'result' => 'failure' );
		}

		delete_option( 'pagezaper_pay_last_error' );
		update_option( 'pagezaper_pay_test_mode', ! empty( $result['test_mode'] ) ? 'yes' : 'no', false );
		$order->update_meta_data( self::META_ID, sanitize_text_field( $result['id'] ) );
		$order->update_meta_data( self::META_RZP, sanitize_text_field( $result['razorpay']['order_id'] ) );
		$order->update_meta_data( self::META_KEY_ID, sanitize_text_field( $result['razorpay']['key_id'] ) );
		$order->save();

		return array(
			'result'   => 'success',
			'redirect' => $order->get_checkout_payment_url( true ),
		);
	}

	/**
	 * The order-pay page: opens Razorpay's checkout.
	 *
	 * @param int $order_id WooCommerce order id.
	 */
	public function receipt_page( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || ! $order->needs_payment() || ! $order->get_meta( self::META_RZP ) ) {
			return;
		}
		$return = add_query_arg(
			array(
				'order_id' => $order->get_id(),
				'key'      => $order->get_order_key(),
				'_wpnonce' => wp_create_nonce( self::NONCE_ACTION . $order->get_id() ),
			),
			WC()->api_request_url( $this->id )
		);

		wp_enqueue_script( 'razorpay-checkout', 'https://checkout.razorpay.com/v1/checkout.js', array(), null, true ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion
		wp_enqueue_script( 'pagezaper-pay-checkout', PAGEZAPER_PAY_URL . 'assets/js/checkout.js', array( 'razorpay-checkout' ), PAGEZAPER_PAY_VERSION, true );
		wp_localize_script(
			'pagezaper-pay-checkout',
			'PageZaperPay',
			array(
				'key'         => $order->get_meta( self::META_KEY_ID ),
				'order_id'    => $order->get_meta( self::META_RZP ),
				'amount'      => self::paise( $order ),
				'currency'    => $order->get_currency(),
				'name'        => get_bloginfo( 'name' ),
				/* translators: %s: order number */
				'description' => sprintf( __( 'Order #%s', 'pagezaper-pay' ), $order->get_order_number() ),
				'prefill'     => array(
					'name'    => trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() ),
					'email'   => $order->get_billing_email(),
					'contact' => $order->get_billing_phone(),
				),
				'return_url'  => $return,
			)
		);

		echo '<p>' . esc_html__( 'Thanks for your order. Complete the payment in the Razorpay window.', 'pagezaper-pay' ) . '</p>';
		echo '<p id="pagezaper-pay-closed" style="display:none">' . esc_html__( 'The payment window was closed before paying.', 'pagezaper-pay' ) . '</p>';
		echo '<button type="button" class="button alt" id="pagezaper-pay-button">' . esc_html__( 'Pay now', 'pagezaper-pay' ) . '</button> ';
		echo '<a class="button cancel" href="' . esc_url( $order->get_cancel_order_url() ) . '">' . esc_html__( 'Cancel order', 'pagezaper-pay' ) . '</a>';
	}

	/**
	 * /wc-api/pagezaper_pay — two callers:
	 *  - the buyer coming back from Razorpay (GET, with the order key and a nonce)
	 *  - PageZaper's nudge once a payment is in (POST {"id": "wco_…"})
	 * Neither is believed: both just trigger verify_and_complete().
	 */
	public function handle_callback() {
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- checked below for the GET; the POST carries no state we trust.
		if ( 'POST' === ( isset( $_SERVER['REQUEST_METHOD'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) : '' ) ) {
			$data = json_decode( (string) file_get_contents( 'php://input' ), true );
			$id   = is_array( $data ) && isset( $data['id'] ) ? sanitize_text_field( $data['id'] ) : '';
			if ( preg_match( '/^wco_[0-9a-f]{24}$/', $id ) ) {
				$orders = wc_get_orders(
					array(
						'limit'          => 1,
						'payment_method' => $this->id,
						'meta_query'     => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
							array(
								'key'   => self::META_ID,
								'value' => $id,
							),
						),
					)
				);
				if ( $orders ) {
					$this->verify_and_complete( $orders[0] );
				}
			}
			wp_send_json( array( 'ok' => true ) );
		}

		$order_id = isset( $_GET['order_id'] ) ? absint( $_GET['order_id'] ) : 0;
		$key      = isset( $_GET['key'] ) ? sanitize_text_field( wp_unslash( $_GET['key'] ) ) : '';
		$nonce    = isset( $_GET['_wpnonce'] ) ? sanitize_text_field( wp_unslash( $_GET['_wpnonce'] ) ) : '';
		// phpcs:enable
		$order = $order_id ? wc_get_order( $order_id ) : false;
		if ( ! $order || $order->get_payment_method() !== $this->id || ! hash_equals( $order->get_order_key(), $key ) ) {
			wp_safe_redirect( wc_get_cart_url() );
			exit;
		}
		if ( wp_verify_nonce( $nonce, self::NONCE_ACTION . $order->get_id() ) && $this->verify_and_complete( $order ) ) {
			wp_safe_redirect( $this->get_return_url( $order ) );
			exit;
		}
		if ( $order->is_paid() ) {
			wp_safe_redirect( $this->get_return_url( $order ) );
			exit;
		}
		wc_add_notice( __( 'We haven’t received your payment yet. If money left your account, it’ll show here within a few minutes — otherwise, please try again.', 'pagezaper-pay' ), 'notice' );
		wp_safe_redirect( $order->get_checkout_payment_url( true ) );
		exit;
	}

	/**
	 * Asks PageZaper whether this order is paid and, if it's paid for this
	 * order at this amount, marks it paid here. Returns true when it's paid.
	 *
	 * @param WC_Order $order Order.
	 * @return bool
	 */
	public function verify_and_complete( $order ) {
		if ( $order->is_paid() ) {
			return true;
		}
		$id = (string) $order->get_meta( self::META_ID );
		if ( '' === $id ) {
			return false;
		}
		$result = $this->api()->get_order( $id );
		if ( is_wp_error( $result ) || ! isset( $result['status'] ) || 'paid' !== $result['status'] ) {
			return false;
		}
		$matches = isset( $result['id'], $result['amount'], $result['wc_order_id'], $result['currency'] )
			&& $result['id'] === $id
			&& (int) $result['amount'] === self::paise( $order )
			&& (string) $result['wc_order_id'] === (string) $order->get_id()
			&& $result['currency'] === $order->get_currency();
		if ( ! $matches ) {
			// The order changed after it was sent to pay (or something's off): a person should look.
			if ( ! $order->has_status( 'on-hold' ) ) {
				$order->update_status( 'on-hold', __( 'PageZaper reports a payment that doesn’t match this order’s total. Check it before shipping.', 'pagezaper-pay' ) );
			}
			return false;
		}
		$payment_id = isset( $result['payment_id'] ) ? sanitize_text_field( (string) $result['payment_id'] ) : '';
		$order->payment_complete( $payment_id );
		/* translators: %s: Razorpay payment id */
		$order->add_order_note( sprintf( __( 'Paid with PageZaper Pay (Razorpay payment %s), confirmed with PageZaper.', 'pagezaper-pay' ), $payment_id ) );
		return true;
	}
}

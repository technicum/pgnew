<?php
/**
 * The PageZaper API (POST /api/v1/wc/orders, GET /api/v1/wc/orders/:id).
 *
 * @package PageZaperPay
 */

defined( 'ABSPATH' ) || exit;

/**
 * A thin client over wp_remote_*. Every call returns the decoded body, or a
 * WP_Error whose code is PageZaper's error code (e.g. payouts_not_active).
 */
class PageZaper_Pay_API {

	/**
	 * Where PageZaper is.
	 *
	 * @var string
	 */
	private $base;

	/**
	 * This site's PageZaper API key (pzwc_…).
	 *
	 * @var string
	 */
	private $key;

	/**
	 * Constructor.
	 *
	 * @param string $key  API key.
	 * @param string $base PageZaper's address.
	 */
	public function __construct( $key, $base = 'https://pagezaper.com' ) {
		$this->key  = (string) $key;
		$this->base = untrailingslashit( $base );
	}

	/**
	 * Creates a PageZaper order for a WooCommerce order.
	 *
	 * @param array $body amount (paise), currency, wc_order_id, notify_url, buyer.
	 * @return array|WP_Error
	 */
	public function create_order( array $body ) {
		return $this->request( 'POST', '/api/v1/wc/orders', $body );
	}

	/**
	 * An order's status, which PageZaper re-checks with Razorpay.
	 *
	 * @param string $id PageZaper order id (wco_…).
	 * @return array|WP_Error
	 */
	public function get_order( $id ) {
		if ( ! preg_match( '/^wco_[0-9a-f]{24}$/', (string) $id ) ) {
			return new WP_Error( 'invalid_id', 'Not a PageZaper order id.' );
		}
		return $this->request( 'GET', '/api/v1/wc/orders/' . rawurlencode( $id ) );
	}

	/**
	 * Sends a request.
	 *
	 * @param string     $method HTTP method.
	 * @param string     $path   Path.
	 * @param array|null $body   JSON body.
	 * @return array|WP_Error
	 */
	private function request( $method, $path, $body = null ) {
		$args = array(
			'method'  => $method,
			'timeout' => 20,
			'headers' => array(
				'Authorization' => 'Bearer ' . $this->key,
				'Accept'        => 'application/json',
				'User-Agent'    => 'PageZaperPay/' . PAGEZAPER_PAY_VERSION . '; WordPress/' . get_bloginfo( 'version' ),
			),
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}
		$response = 'POST' === $method
			? wp_remote_post( $this->base . $path, $args )
			: wp_remote_get( $this->base . $path, $args );
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'unreachable', $response->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		$data = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( $code < 200 || $code >= 300 ) {
			$error = is_array( $data ) && isset( $data['error'] ) ? $data['error'] : array();
			return new WP_Error(
				isset( $error['code'] ) ? sanitize_key( $error['code'] ) : 'http_' . $code,
				isset( $error['message'] ) ? sanitize_text_field( $error['message'] ) : 'PageZaper returned HTTP ' . $code
			);
		}
		return is_array( $data ) ? $data : new WP_Error( 'bad_response', 'PageZaper sent an unreadable reply.' );
	}
}

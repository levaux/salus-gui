/**
 * headers — metadata keys the bridge itself interprets.
 *
 * Everything else crosses verbatim. `salus-admin-target` is the one header the
 * bridge consumes rather than forwards: it selects which Component's Admin
 * surface a call reaches, and sending it upstream would be meaningless there.
 */
export const ADMIN_TARGET_HEADER = 'salus-admin-target';

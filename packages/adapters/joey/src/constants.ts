/**
 * Constants for the Joey Wallet adapter
 */

/**
 * Default app metadata sent to Joey Wallet during pairing, used when the
 * consumer doesn't supply their own `metadata` option.
 */
export const DEFAULT_METADATA = {
  NAME: 'XRPL Connect',
  DESCRIPTION: 'XRPL Wallet Connection',
  DEFAULT_URL: 'https://xrpl.org',
  DEFAULT_ICON: 'https://xrpl.org/favicon.ico',
} as const;

/**
 * Account parsing configuration - matches the "xrpl:chainId:rAddress" CAIP-10
 * account format used across every XRPL WalletConnect session.
 */
export const ACCOUNT_FORMAT = {
  ADDRESS_INDEX: 2,
} as const;

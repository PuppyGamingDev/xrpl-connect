/**
 * Joey-specific types.
 *
 * `@joey-wallet/wc-client` wraps `@walletconnect/universal-provider`, but only
 * ships React-first documentation (`@joey-wallet/wc-client/react`). This
 * adapter talks to the framework-agnostic `@joey-wallet/wc-client/core` entry
 * point instead, so these types describe just the slice of that surface (and
 * of the raw WalletConnect provider it hands back) that the adapter uses.
 */

/** WalletConnect CAIP-10 session shape ("xrpl:chainId:rAddress" accounts). */
export interface JoeySession {
  topic: string;
  namespaces: {
    xrpl?: {
      accounts: string[];
    };
  };
}

/**
 * The raw `@walletconnect/universal-provider` instance returned by
 * `wcProvider.head()`. Joey's own docs (see the `generate` action example)
 * subscribe to `connect`/`error` directly on this object, and it is a
 * standard WalletConnect `EventEmitter` supporting the session lifecycle
 * events (`session_delete`, `session_expire`, `disconnect`, `session_event`).
 */
export interface JoeyRawProvider {
  session?: JoeySession;
  request<T>(args: { method: string; params: unknown }, chainId?: string): Promise<T>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/** Options accepted by the Joey Wallet adapter constructor. */
export interface JoeyAdapterOptions {
  /** WalletConnect / Reown Cloud project ID for *your* app (https://cloud.reown.com). */
  projectId: string;
  /** App metadata shown to the user inside Joey Wallet during pairing. */
  metadata?: {
    name: string;
    description: string;
    url: string;
    icons: string[];
    redirect?: { universal?: string; native?: string };
  };
}

/** Joey-specific `connect()` options. */
export type JoeyConnectOptions = {
  /** Called with the pairing URI so the caller can render it as a QR code (desktop). */
  onQRCode?: (uri: string) => void;
};

/** Standard WalletConnect `session_event` payload shape. */
export interface JoeySessionEventPayload {
  params?: {
    chainId?: string;
    event?: {
      name?: string;
      data?: unknown;
    };
  };
}

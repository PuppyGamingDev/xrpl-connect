/**
 * Joey Wallet Adapter for XRPL
 *
 * Joey Wallet is a WalletConnect v2 wallet, integrated here via Joey's own
 * SDK (`@joey-wallet/wc-client`) rather than talking to
 * `@walletconnect/universal-provider` directly. The SDK's `generate` action
 * targets Joey's own `walletId`, which is what lets this adapter deep-link
 * / QR-link straight into Joey instead of opening a generic multi-wallet
 * WalletConnect picker.
 *
 * `@joey-wallet/wc-client` only documents a React integration
 * (`@joey-wallet/wc-client/react`). This adapter is framework-agnostic, so
 * it drives the lower-level `@joey-wallet/wc-client/core` entry point
 * directly - the same `provider.Provider` class the React hook wraps, and
 * the same `methods.signTransaction`/`signTransactionFor` helpers its
 * "Transaction Signing" example calls.
 */

import core from '@joey-wallet/wc-client/core';
import type {
  WalletAdapter,
  WalletAdapterEvent,
  AccountInfo,
  ConnectOptions,
  NetworkInfo,
  Transaction,
  SignedTransaction,
  SignedMessage,
  SubmittedTransaction,
} from '@xrpl-connect/core';
import {
  createWalletError,
  resolveNetwork,
  createLogger,
  isMobile,
  STANDARD_NETWORKS,
} from '@xrpl-connect/core';
import iconPng from './assets/icon.png';
import { DEFAULT_METADATA, ACCOUNT_FORMAT } from './constants';
import type {
  JoeyAdapterOptions,
  JoeyConnectOptions,
  JoeyRawProvider,
  JoeySessionEventPayload,
} from './types';

export type { JoeyAdapterOptions, JoeyConnectOptions } from './types';

const logger = createLogger('[Joey]');

/**
 * Signed transaction JSON returned by Joey in response to
 * `xrpl_signTransaction` / `xrpl_signTransactionFor`. Same wire format as
 * the standard XRPL WalletConnect RPC spec used by the `walletconnect`
 * adapter: the wallet returns the transaction hash alongside the signed
 * fields, not a separate response envelope.
 */
type JoeySignedTxJson = Transaction & { hash?: string; TxnSignature?: string };

type WcProvider = InstanceType<typeof core.provider.Provider>;

/**
 * Joey Wallet adapter implementation using `@joey-wallet/wc-client`.
 */
export class JoeyAdapter implements WalletAdapter {
  readonly id = 'joey';
  readonly name = 'Joey Wallet';
  readonly icon = iconPng;
  readonly url = 'https://joeywallet.xyz';

  private options: JoeyAdapterOptions;
  private wcProvider: WcProvider | null = null;
  private rawProvider: JoeyRawProvider | null = null;
  private currentAccount: AccountInfo | null = null;
  private listeners: Map<WalletAdapterEvent, Set<(data: unknown) => void>> = new Map();

  // Guards against overlapping connect() calls - e.g. WalletManager's
  // autoConnect silently reconnecting stored state in the background while
  // the user also clicks "Connect" in the UI. Without this, both calls
  // start independent WalletConnect pairing negotiations on the same
  // client, and the approval can land on whichever one the user didn't
  // actually see/scan.
  private connectingPromise: Promise<AccountInfo> | null = null;
  private pendingUri: string | null = null;
  private onQRCodeCallback: ((uri: string) => void) | null = null;

  private sessionDeleteHandler: (() => void) | null = null;
  private sessionExpireHandler: (() => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private sessionEventHandler: ((payload: unknown) => void) | null = null;
  private sessionUpdateHandler: (() => void) | null = null;

  constructor(options: JoeyAdapterOptions) {
    this.options = options;
  }

  /**
   * Joey is WalletConnect-based - it doesn't require a browser extension, so
   * it's always available (mirrors `WalletConnectAdapter.isAvailable`).
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Lazily create the wc-client `Provider`. Its own `connect`/
   * `generateConnectionDetails` methods take care of initializing the
   * underlying WalletConnect session on first use.
   */
  private getProvider(): WcProvider {
    if (!this.wcProvider) {
      const strictConfig = core.utils.configBuilder({
        projectId: this.options.projectId,
        metadata: this.options.metadata ?? {
          name: DEFAULT_METADATA.NAME,
          description: DEFAULT_METADATA.DESCRIPTION,
          url:
            typeof window !== 'undefined' ? window.location.origin : DEFAULT_METADATA.DEFAULT_URL,
          icons: [DEFAULT_METADATA.DEFAULT_ICON],
        },
        walletDetails: [core.constants.wallets.joey],
      });
      this.wcProvider = new core.provider.Provider(strictConfig);
    }
    return this.wcProvider;
  }

  /**
   * Connect to Joey Wallet.
   *
   * Uses the SDK's `generate` action (targeted at Joey's own `walletId`)
   * rather than the generic `connect` action, so this never falls back to a
   * multi-wallet WalletConnect picker. On mobile it deep-links straight into
   * the Joey app; on desktop it surfaces the pairing URI via `onQRCode` so
   * the UI layer can render it as a QR code, the same convention the
   * `walletconnect` adapter uses.
   */
  async connect(options?: ConnectOptions<JoeyConnectOptions>): Promise<AccountInfo> {
    // A connect() may already be in flight (most commonly WalletManager's
    // autoConnect silently reconnecting on load). Attach this call's
    // onQRCode to it - firing immediately with the URI if it's already
    // available - and reuse the same in-flight pairing instead of starting
    // a second, competing one.
    if (options?.onQRCode) {
      this.onQRCodeCallback = options.onQRCode;
      if (this.pendingUri) {
        this.onQRCodeCallback(this.pendingUri);
      }
    }
    if (this.connectingPromise) {
      logger.debug('Joey connect() already in progress; reusing the in-flight attempt');
      return this.connectingPromise;
    }

    this.connectingPromise = this.performConnect(options).finally(() => {
      this.connectingPromise = null;
      this.pendingUri = null;
      this.onQRCodeCallback = null;
    });
    return this.connectingPromise;
  }

  private async performConnect(options?: ConnectOptions<JoeyConnectOptions>): Promise<AccountInfo> {
    if (!this.options.projectId) {
      throw createWalletError.connectionFailed(
        this.name,
        new Error(
          'Joey Wallet requires a WalletConnect project ID. Get one from https://cloud.reown.com'
        )
      );
    }

    try {
      const network = resolveNetwork(options?.network);
      const wcProvider = this.getProvider();
      const rawProvider = (await wcProvider.head()) as unknown as JoeyRawProvider;
      this.rawProvider = rawProvider;

      // WalletConnect's underlying provider auto-restores a previously
      // approved session from persisted storage as part of initializing
      // above. If one exists, generateConnectionDetails() below would just
      // reuse it - silently keeping whichever chain that old session was
      // approved for instead of pairing fresh for the chain we actually
      // want. Clear it first so every connect() negotiates the requested
      // network from scratch.
      if (rawProvider.session) {
        logger.debug('Clearing a pre-existing Joey session before reconnecting');
        try {
          await rawProvider.disconnect();
        } catch (error) {
          logger.debug('Failed to clear the pre-existing Joey session:', error);
        }
      }

      const chainId = network.walletConnectId || `xrpl:${network.id}`;
      logger.info(`Requesting Joey connection for chain ${chainId} (network: ${network.id})`);

      const generated = await wcProvider.generateConnectionDetails({
        walletId: core.constants.wallets.joey.projectId,
        chain: chainId,
      });

      if (generated.error || !generated.data) {
        throw generated.error ?? new Error('Failed to generate Joey Wallet connection details');
      }

      const { uri, deeplink } = generated.data;

      if (isMobile()) {
        logger.debug('Deep-linking into Joey Wallet');
        window.location.href = deeplink;
      } else {
        // Cache the URI so a later, overlapping connect() call (see
        // connect() above) can still receive it even though this call
        // owns the actual pairing.
        this.pendingUri = uri;
        if (this.onQRCodeCallback) {
          logger.debug('Surfacing Joey Wallet pairing URI as QR code');
          this.onQRCodeCallback(uri);
        }
      }

      await new Promise<void>((resolve, reject) => {
        const cleanupListeners = () => {
          rawProvider.off('connect', onConnect);
          rawProvider.off('error', onError);
        };
        const onConnect = () => {
          cleanupListeners();
          resolve();
        };
        const onError = (error: unknown) => {
          cleanupListeners();
          reject(error instanceof Error ? error : new Error('Failed to connect to Joey Wallet'));
        };
        rawProvider.on('connect', onConnect);
        rawProvider.on('error', onError);
      });

      const accounts = rawProvider.session?.namespaces?.xrpl?.accounts ?? [];
      logger.info(`Joey session namespaces:`, rawProvider.session?.namespaces);
      if (accounts.length === 0) {
        throw new Error('No accounts returned from Joey Wallet session');
      }

      // Trust the chain the wallet actually approved (encoded in the CAIP-10
      // account string) over the one we requested. Joey's `generate()`
      // namespace negotiation isn't guaranteed 1:1 with `chain` - falling
      // back to the requested `network` here silently signs against the
      // wrong chainId and gets rejected by the WalletConnect session as
      // "Missing or invalid" whenever the two disagree.
      const [approvedNamespace, approvedChainRef, address] = accounts[0].split(':');
      const approvedChainId = `${approvedNamespace}:${approvedChainRef}`;
      const approvedNetwork =
        Object.values(STANDARD_NETWORKS).find((n) => n.walletConnectId === approvedChainId) ??
        network;

      if (approvedChainId !== chainId) {
        logger.warn(
          `Joey approved chain ${approvedChainId} but ${chainId} was requested - using the approved chain.`
        );
      }

      this.currentAccount = { address, network: approvedNetwork };
      this.setupEventListeners();
      this.emit('connect', this.currentAccount);

      return this.currentAccount;
    } catch (error) {
      this.rawProvider = null;
      throw createWalletError.connectionFailed(this.name, error as Error);
    }
  }

  /**
   * Disconnect from Joey Wallet.
   */
  async disconnect(): Promise<void> {
    if (!this.rawProvider) {
      return;
    }

    try {
      await this.rawProvider.disconnect();
    } catch (error) {
      // Disconnect might fail if already disconnected, that's okay
      logger.debug('Disconnect request failed (likely already disconnected):', error);
    }

    this.cleanup();
    this.emit('disconnect');
  }

  /**
   * Get current account
   */
  async getAccount(): Promise<AccountInfo | null> {
    return this.currentAccount;
  }

  /**
   * Get current network
   */
  async getNetwork(): Promise<NetworkInfo> {
    if (!this.currentAccount) {
      throw createWalletError.notConnected();
    }
    return this.currentAccount.network;
  }

  /**
   * Send a Joey `xrpl_signTransaction` / `xrpl_signTransactionFor` request
   */
  private async requestSignTransaction(
    transaction: Transaction,
    submit: boolean
  ): Promise<JoeySignedTxJson> {
    if (!this.rawProvider || !this.currentAccount) {
      throw createWalletError.notConnected();
    }

    const tx = {
      ...transaction,
      Account: transaction.Account || this.currentAccount.address,
    };

    const chainId =
      this.currentAccount.network.walletConnectId || `xrpl:${this.currentAccount.network.id}`;

    const result = await core.methods.signTransaction({
      // The core `methods` helpers only need `request`/`provider`/`chainId`
      // off the raw WalletConnect provider that Joey's SDK hands back.
      provider: this.rawProvider as never,
      chainId,
      request: {
        tx_json: tx,
        options: { autofill: true, submit },
      },
    });

    // `core.methods.signTransaction` types its response as
    // `{ tx_json: xrpl.TransactionAndMetadata }`, but its implementation is a
    // passthrough of the raw WalletConnect `xrpl_signTransaction` RPC result
    // (same wire format the `walletconnect` adapter already handles), which
    // is a flat signed `tx_json` - not the `{transaction, metadata}` shape
    // the SDK's own type declares.
    return result.tx_json as unknown as JoeySignedTxJson;
  }

  /**
   * Sign a transaction without submitting it to the ledger
   */
  async sign(transaction: Transaction): Promise<SignedTransaction> {
    try {
      const resultTx = await this.requestSignTransaction(transaction, false);

      return {
        hash: resultTx.hash || '',
        signature: resultTx.TxnSignature,
        tx_json: resultTx,
      };
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('reject')) {
        throw createWalletError.signRejected();
      }
      throw createWalletError.signFailed(error as Error);
    }
  }

  /**
   * Sign and submit a transaction to the ledger
   */
  async signAndSubmit(transaction: Transaction): Promise<SubmittedTransaction> {
    try {
      const resultTx = await this.requestSignTransaction(transaction, true);

      return {
        hash: resultTx.hash || '',
        signature: resultTx.TxnSignature,
        tx_json: resultTx,
      };
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('reject')) {
        throw createWalletError.signRejected();
      }
      throw createWalletError.signFailed(error as Error);
    }
  }

  /**
   * Sign a message - NOT SUPPORTED.
   *
   * Joey's documented XRPL methods are all transaction-signing calls
   * (`xrpl_signTransaction`, `xrpl_signTransactionFor`,
   * `xrpl_signTransactionBulk`) - there is no message-signing equivalent, so
   * this throws the same "unsupported method" error the `walletconnect`
   * adapter uses for capabilities it can't support, rather than faking it
   * with a signed dummy transaction.
   */
  async signMessage(_message: string | Uint8Array): Promise<SignedMessage> {
    throw createWalletError.unsupportedMethod(
      'Message signing is not supported by Joey Wallet. Please use Xaman, Crossmark, or GemWallet for signing messages.'
    );
  }

  // ==================== Events ====================

  on(event: WalletAdapterEvent, callback: (data: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: WalletAdapterEvent, callback: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: WalletAdapterEvent, data?: unknown): void {
    this.listeners.get(event)?.forEach((callback) => callback(data));
  }

  /**
   * Forward the underlying WalletConnect session's own disconnect /
   * accountsChanged events into this adapter's emitter, the way
   * `setupWalletListeners()` does in the official adapter template.
   */
  private setupEventListeners(): void {
    if (!this.rawProvider) return;

    this.removeEventListeners();

    this.sessionDeleteHandler = () => this.handleWalletInitiatedDisconnect();
    this.sessionExpireHandler = () => this.handleWalletInitiatedDisconnect();
    this.disconnectHandler = () => this.handleWalletInitiatedDisconnect();
    this.sessionEventHandler = (payload: unknown) => this.handleSessionEvent(payload);
    this.sessionUpdateHandler = () => this.handleSessionUpdate();

    this.rawProvider.on('session_delete', this.sessionDeleteHandler);
    this.rawProvider.on('session_expire', this.sessionExpireHandler);
    this.rawProvider.on('disconnect', this.disconnectHandler);
    this.rawProvider.on('session_event', this.sessionEventHandler);
    this.rawProvider.on('session_update', this.sessionUpdateHandler);
  }

  private removeEventListeners(): void {
    if (this.rawProvider) {
      if (this.sessionDeleteHandler)
        this.rawProvider.off('session_delete', this.sessionDeleteHandler);
      if (this.sessionExpireHandler)
        this.rawProvider.off('session_expire', this.sessionExpireHandler);
      if (this.disconnectHandler) this.rawProvider.off('disconnect', this.disconnectHandler);
      if (this.sessionEventHandler) this.rawProvider.off('session_event', this.sessionEventHandler);
      if (this.sessionUpdateHandler)
        this.rawProvider.off('session_update', this.sessionUpdateHandler);
    }
    this.sessionDeleteHandler = null;
    this.sessionExpireHandler = null;
    this.disconnectHandler = null;
    this.sessionEventHandler = null;
    this.sessionUpdateHandler = null;
  }

  private handleWalletInitiatedDisconnect(): void {
    this.cleanup();
    this.emit('disconnect');
  }

  private handleSessionEvent(payload: unknown): void {
    const eventName = (payload as JoeySessionEventPayload)?.params?.event?.name;
    if (eventName !== 'accountsChanged' || !this.currentAccount) return;

    const data = (payload as JoeySessionEventPayload)?.params?.event?.data;
    const nextAccount = Array.isArray(data) ? String(data[0]) : undefined;
    const nextAddress = nextAccount?.split(':')[ACCOUNT_FORMAT.ADDRESS_INDEX] ?? nextAccount;

    if (nextAddress && nextAddress !== this.currentAccount.address) {
      this.currentAccount = { ...this.currentAccount, address: nextAddress };
      this.emit('accountChanged', this.currentAccount);
    }
  }

  /**
   * A `session_update` means the wallet re-negotiated the session's own
   * namespaces in place (e.g. the user switched network inside Joey) -
   * distinct from `session_event`'s app-level `accountsChanged` signal.
   * Re-derive the connected account from the CAIP-10 account string the
   * updated session actually reports, the same way `connect()` does, and
   * notify listeners if either the network or the address moved.
   */
  private handleSessionUpdate(): void {
    if (!this.currentAccount) return;

    const accounts = this.rawProvider?.session?.namespaces?.xrpl?.accounts ?? [];
    if (accounts.length === 0) return;

    const [namespace, chainRef, address] = accounts[0].split(':');
    const chainId = `${namespace}:${chainRef}`;
    const network =
      Object.values(STANDARD_NETWORKS).find((n) => n.walletConnectId === chainId) ??
      this.currentAccount.network;

    const networkChanged = network.id !== this.currentAccount.network.id;
    const addressChanged = address !== this.currentAccount.address;
    if (!networkChanged && !addressChanged) return;

    logger.info(`Joey session updated: chain ${chainId}, account ${address}`);
    this.currentAccount = { address, network };

    if (networkChanged) {
      this.emit('networkChanged', this.currentAccount);
    }
    if (addressChanged) {
      this.emit('accountChanged', this.currentAccount);
    }
  }

  /**
   * Cleanup adapter state
   */
  private cleanup(): void {
    this.removeEventListeners();
    this.rawProvider = null;
    this.currentAccount = null;
  }
}

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WalletErrorCode, type Transaction } from '@xrpl-connect/core';

const {
  mockRawProvider,
  mockWcProviderInstance,
  ProviderMock,
  configBuilderMock,
  signTransactionMock,
} = vi.hoisted(() => {
  const mockRawProvider = {
    session: undefined as
      | { topic: string; namespaces: { xrpl?: { accounts: string[] } } }
      | undefined,
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockWcProviderInstance = {
    head: vi.fn(),
    generateConnectionDetails: vi.fn(),
  };

  return {
    mockRawProvider,
    mockWcProviderInstance,
    ProviderMock: vi.fn(() => mockWcProviderInstance),
    configBuilderMock: vi.fn((config: unknown) => config),
    signTransactionMock: vi.fn(),
  };
});

vi.mock('@joey-wallet/wc-client/core', () => ({
  default: {
    provider: { Provider: ProviderMock },
    utils: { configBuilder: configBuilderMock },
    constants: { wallets: { joey: { projectId: 'joey-wallet-id', name: 'Joey Wallet' } } },
    methods: { signTransaction: signTransactionMock },
  },
}));

import { JoeyAdapter } from '../src/joey-adapter';

/** Makes `rawProvider.on('connect', cb)` fire `cb` immediately, simulating an instant approval. */
function connectsImmediately() {
  mockRawProvider.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'connect') cb();
  });
}

/** Makes `rawProvider.on('error', cb)` fire `cb` immediately with the given error. */
function failsImmediately(error: Error) {
  mockRawProvider.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'error') cb(error);
  });
}

/**
 * Simulates a fresh approval landing with the given session, replacing
 * whatever `mockRawProvider.session` held beforehand (e.g. a stale,
 * pre-existing one) - the way a real pairing replaces the provider's
 * session once the user approves.
 */
function connectsWithSession(session: NonNullable<(typeof mockRawProvider)['session']>) {
  mockRawProvider.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'connect') {
      mockRawProvider.session = session;
      cb();
    }
  });
}

beforeEach(() => {
  ProviderMock.mockClear();
  configBuilderMock.mockClear();
  signTransactionMock.mockReset();
  mockRawProvider.session = undefined;
  mockRawProvider.on.mockReset();
  mockRawProvider.off.mockReset();
  mockRawProvider.disconnect.mockReset();
  mockWcProviderInstance.head.mockReset().mockResolvedValue(mockRawProvider);
  mockWcProviderInstance.generateConnectionDetails.mockReset();
});

describe('JoeyAdapter metadata', () => {
  it('has the correct id, name, icon and url', () => {
    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    expect(adapter.id).toBe('joey');
    expect(adapter.name).toBe('Joey Wallet');
    expect(adapter.icon).toBeTruthy();
    expect(adapter.url).toBe('https://joeywallet.xyz');
  });
});

describe('JoeyAdapter.isAvailable', () => {
  it('is always available (WalletConnect-based, no extension required)', async () => {
    await expect(new JoeyAdapter({ projectId: 'test-project-id' }).isAvailable()).resolves.toBe(
      true
    );
  });
});

describe('JoeyAdapter.connect', () => {
  it('throws a connection error when no project ID is provided', async () => {
    const adapter = new JoeyAdapter({ projectId: '' });
    await expect(adapter.connect()).rejects.toMatchObject({
      code: WalletErrorCode.CONNECTION_FAILED,
    });
  });

  it('targets Joey directly via generateConnectionDetails, not the generic connect flow', async () => {
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:0:rJoeyWalletAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });
    connectsImmediately();

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    const account = await adapter.connect();

    expect(mockWcProviderInstance.generateConnectionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'joey-wallet-id' })
    );
    expect(account.address).toBe('rJoeyWalletAddress');
    expect(account.network.id).toBe('mainnet');
  });

  it('trusts the chain the wallet actually approved over the one requested', async () => {
    // App asks for testnet (default network below), but the session comes
    // back with an account on mainnet - the adapter must follow the
    // approved account's chain, not blindly keep the requested network,
    // or later sign()/signAndSubmit() calls send the wrong chainId and get
    // rejected by the WalletConnect session validation.
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:0:rMainnetAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });
    connectsImmediately();

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    const account = await adapter.connect({ network: 'testnet' });

    expect(account.network.id).toBe('mainnet');
    expect(account.network.walletConnectId).toBe('xrpl:0');

    signTransactionMock.mockResolvedValue({
      tx_json: { hash: 'HASH', TransactionType: 'Payment', TxnSignature: 'SIG' },
    });
    await adapter.sign({ TransactionType: 'Payment' } as Transaction);

    expect(signTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 'xrpl:0' })
    );
  });

  it('clears a pre-existing session before pairing, so a stale mainnet session cannot leak into a fresh testnet connect', async () => {
    // WalletConnect's provider auto-restores a previously approved session
    // (e.g. from an earlier mainnet connection) as part of initializing.
    // Without clearing it first, generateConnectionDetails() would just
    // reuse that stale session instead of negotiating the newly requested
    // network.
    mockRawProvider.session = {
      topic: 'stale-mainnet-topic',
      namespaces: { xrpl: { accounts: ['xrpl:0:rStaleMainnetAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });
    connectsWithSession({
      topic: 'fresh-testnet-topic',
      namespaces: { xrpl: { accounts: ['xrpl:1:rFreshTestnetAddress'] } },
    });

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    const account = await adapter.connect({ network: 'testnet' });

    expect(mockRawProvider.disconnect).toHaveBeenCalled();
    expect(account.address).toBe('rFreshTestnetAddress');
    expect(account.network.walletConnectId).toBe('xrpl:1');
  });

  it('reuses an in-flight connect() instead of starting a second, competing pairing', async () => {
    // Mirrors WalletManager's autoConnect silently reconnecting stored
    // state (no onQRCode) racing against the user's manual click (with
    // onQRCode) before the first attempt resolves. Both must land on the
    // SAME session, and only one pairing should ever be negotiated.
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:1:rConcurrentAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:shared-uri', deeplink: 'joey://settings/wc?uri=wc:shared-uri' },
      error: null,
    });
    connectsImmediately();

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    const onQRCode = vi.fn();

    const [silentAccount, manualAccount] = await Promise.all([
      adapter.connect({ network: 'testnet' }),
      adapter.connect({ network: 'testnet', onQRCode }),
    ]);

    expect(mockWcProviderInstance.generateConnectionDetails).toHaveBeenCalledTimes(1);
    expect(onQRCode).toHaveBeenCalledWith('wc:shared-uri');
    expect(silentAccount).toEqual(manualAccount);
    expect(silentAccount.address).toBe('rConcurrentAddress');
  });

  it('surfaces the pairing URI via onQRCode on desktop', async () => {
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:0:rJoeyWalletAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example-uri', deeplink: 'joey://settings/wc?uri=wc:example-uri' },
      error: null,
    });
    connectsImmediately();

    const onQRCode = vi.fn();
    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await adapter.connect({ onQRCode });

    expect(onQRCode).toHaveBeenCalledWith('wc:example-uri');
  });

  it('emits a connect event with the resulting account', async () => {
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:0:rJoeyWalletAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });
    connectsImmediately();

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    const onConnect = vi.fn();
    adapter.on('connect', onConnect);

    await adapter.connect();

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'rJoeyWalletAddress' })
    );
  });

  it('wraps a provider error event into a connection error', async () => {
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });
    failsImmediately(new Error('Failed to connect'));

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await expect(adapter.connect()).rejects.toMatchObject({
      code: WalletErrorCode.CONNECTION_FAILED,
    });
  });

  it('wraps a generate() failure into a connection error', async () => {
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: null,
      error: new Error('generate failed'),
    });

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await expect(adapter.connect()).rejects.toMatchObject({
      code: WalletErrorCode.CONNECTION_FAILED,
    });
  });
});

describe('JoeyAdapter.sign / signAndSubmit', () => {
  async function connected() {
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:0:rJoeyWalletAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });
    connectsImmediately();

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await adapter.connect();
    return adapter;
  }

  it('signs a transaction via xrpl_signTransaction and returns hash + signature', async () => {
    const adapter = await connected();
    signTransactionMock.mockResolvedValue({
      tx_json: {
        hash: 'ABCDEF0123456789',
        TransactionType: 'Payment',
        SigningPubKey: 'PUB',
        TxnSignature: 'SIG',
      },
    });

    const result = await adapter.sign({ TransactionType: 'Payment' } as Transaction);

    expect(signTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ options: { autofill: true, submit: false } }),
      })
    );
    expect(result.hash).toBe('ABCDEF0123456789');
    expect(result.signature).toBe('SIG');
  });

  it('submits when signAndSubmit is called', async () => {
    const adapter = await connected();
    signTransactionMock.mockResolvedValue({
      tx_json: { hash: 'HASH1', TransactionType: 'Payment', TxnSignature: 'SIG' },
    });

    const result = await adapter.signAndSubmit({ TransactionType: 'Payment' } as Transaction);

    expect(signTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ options: { autofill: true, submit: true } }),
      })
    );
    expect(result.hash).toBe('HASH1');
  });

  it('maps a rejected request to sign-rejected', async () => {
    const adapter = await connected();
    signTransactionMock.mockRejectedValue(new Error('User rejected the request'));

    await expect(adapter.sign({ TransactionType: 'Payment' } as Transaction)).rejects.toMatchObject(
      {
        code: WalletErrorCode.SIGN_REJECTED,
      }
    );
  });

  it('throws before any session is established', async () => {
    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await expect(adapter.sign({ TransactionType: 'Payment' } as Transaction)).rejects.toMatchObject(
      {
        code: WalletErrorCode.SIGN_FAILED,
      }
    );
  });
});

describe('JoeyAdapter.signMessage', () => {
  it('throws the standard unsupported-method error, not a faked signature', async () => {
    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await expect(adapter.signMessage('test')).rejects.toMatchObject({
      code: WalletErrorCode.UNSUPPORTED_METHOD,
    });
    await expect(adapter.signMessage('test')).rejects.toThrow(/not supported by Joey/i);
  });
});

describe('JoeyAdapter.disconnect', () => {
  it('clears the session and account after a successful disconnect', async () => {
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:0:rJoeyWalletAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });
    connectsImmediately();

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await adapter.connect();
    expect(await adapter.getAccount()).not.toBeNull();

    await adapter.disconnect();

    expect(mockRawProvider.disconnect).toHaveBeenCalled();
    expect(await adapter.getAccount()).toBeNull();
  });

  it('is a no-op when no session exists', async () => {
    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(mockRawProvider.disconnect).not.toHaveBeenCalled();
  });

  it('emits a disconnect event when the wallet session is deleted remotely', async () => {
    mockRawProvider.session = {
      topic: 'topic-1',
      namespaces: { xrpl: { accounts: ['xrpl:0:rJoeyWalletAddress'] } },
    };
    mockWcProviderInstance.generateConnectionDetails.mockResolvedValue({
      data: { uri: 'wc:example', deeplink: 'joey://settings/wc?uri=wc:example' },
      error: null,
    });

    let sessionDeleteHandler: (() => void) | undefined;
    mockRawProvider.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'connect') cb();
      if (event === 'session_delete') sessionDeleteHandler = cb;
    });

    const adapter = new JoeyAdapter({ projectId: 'test-project-id' });
    const onDisconnect = vi.fn();
    adapter.on('disconnect', onDisconnect);
    await adapter.connect();

    expect(sessionDeleteHandler).toBeDefined();
    sessionDeleteHandler?.();

    expect(onDisconnect).toHaveBeenCalled();
    expect(await adapter.getAccount()).toBeNull();
  });
});

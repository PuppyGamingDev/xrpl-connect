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

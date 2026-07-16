import { describe, it, expect, vi } from 'vitest';
import { WalletService } from '../src/services/WalletService';

describe('WalletService', () => {
  it('should connect to a wallet', async () => {
    const mockWalletManager = {
      wallets: [{ id: 'mockWallet', name: 'Mock Wallet', isAvailable: async () => true }],
      connect: vi.fn(),
    };
    const mockComponent = {
      showLoadingView: vi.fn(),
      showQRCodeView: vi.fn(),
      showAccountSelectionView: vi.fn(),
      showErrorView: vi.fn(),
      dispatchEvent: vi.fn(),
      setQRCode: vi.fn(),
      close: vi.fn(),
    };
    const walletService = new WalletService(mockWalletManager as any, mockComponent as any);

    await walletService.connectWallet('mockWallet');

    expect(mockWalletManager.connect).toHaveBeenCalledWith('mockWallet', undefined);
  });

  it('shows the QR view and forwards an onQRCode callback for joey on desktop', async () => {
    const mockWalletManager = {
      wallets: [{ id: 'joey', name: 'Joey Wallet', isAvailable: async () => true }],
      connect: vi.fn(),
    };
    const mockComponent = {
      showLoadingView: vi.fn(),
      showQRCodeView: vi.fn(),
      showAccountSelectionView: vi.fn(),
      showErrorView: vi.fn(),
      dispatchEvent: vi.fn(),
      setQRCode: vi.fn(),
      close: vi.fn(),
    };
    const walletService = new WalletService(mockWalletManager as any, mockComponent as any);

    await walletService.connectWallet('joey');

    expect(mockComponent.showQRCodeView).toHaveBeenCalledWith('joey');
    expect(mockWalletManager.connect).toHaveBeenCalledWith(
      'joey',
      expect.objectContaining({ onQRCode: expect.any(Function) })
    );

    // Simulate the adapter surfacing a pairing URI through the callback
    const [, connectOptions] = mockWalletManager.connect.mock.calls[0];
    connectOptions.onQRCode('wc:example-uri');
    expect(mockComponent.setQRCode).toHaveBeenCalledWith('joey', 'wc:example-uri');
  });
});

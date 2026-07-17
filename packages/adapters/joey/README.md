# @xrpl-connect/adapter-joey

Joey Wallet adapter for XRPL Connect.

Joey Wallet is a WalletConnect v2 wallet. This adapter is integrated via
Joey's own SDK (`@joey-wallet/wc-client`) rather than the generic
`@xrpl-connect/adapter-walletconnect` adapter, so connecting through it
targets Joey directly - deep-linking straight into the Joey app on mobile,
or rendering a Joey-specific QR code on desktop - instead of opening a
generic multi-wallet WalletConnect picker.

## Installation

```bash
npm install @xrpl-connect/adapter-joey
# or
pnpm add @xrpl-connect/adapter-joey
# or
yarn add @xrpl-connect/adapter-joey
```

## Usage

### Basic Setup

Joey is WalletConnect-based, so it needs a WalletConnect / Reown Cloud
project ID (get one for free at [cloud.reown.com](https://cloud.reown.com)):

```typescript
import { WalletManager } from '@xrpl-connect/core';
import { JoeyAdapter } from '@xrpl-connect/adapter-joey';

const walletManager = new WalletManager({
  adapters: [
    new JoeyAdapter({
      projectId: 'YOUR_WALLETCONNECT_PROJECT_ID',
    }),
  ],
  network: 'testnet',
});
```

### Connect

```typescript
// Desktop: renders a Joey-targeted QR code (pass onQRCode to receive the URI
// yourself, e.g. when driving the adapter directly instead of through
// @xrpl-connect/ui's <xrpl-wallet-connector>).
// Mobile: deep-links straight into the Joey app.
const account = await walletManager.connect('joey', {
  onQRCode: (uri) => {
    console.log('Scan this with Joey Wallet:', uri);
  },
});

console.log('Connected:', account.address);
```

### Sign / Submit a Transaction

```typescript
const result = await walletManager.signAndSubmit({
  TransactionType: 'Payment',
  Destination: 'rN7n7otQDd6FczFgLdlqtyMVrn3KeKniv',
  Amount: '1000000', // 1 XRP in drops
});

console.log('Transaction hash:', result.hash);
```

## Configuration Options

### `JoeyAdapterOptions`

| Option      | Type     | Required | Description                                                            |
| ----------- | -------- | -------- | ---------------------------------------------------------------------- |
| `projectId` | `string` | Yes      | WalletConnect / Reown Cloud project ID for _your_ app                  |
| `metadata`  | `object` | No       | App metadata (`name`, `description`, `url`, `icons`) shown inside Joey |

> **Use a dedicated project ID for Joey.** If your app also uses
> `@xrpl-connect/adapter-walletconnect` (or any other independent
> WalletConnect client), **do not reuse the same `projectId`** for both.
> Joey's SDK builds its own internal WalletConnect client, and WalletConnect
> maintains one "Core" (relay connection + session storage) per project ID.
> Two independent clients sharing a project ID collide over that same Core -
> you'll see a "WalletConnect Core is already initialized" console warning,
> and connections can silently negotiate the wrong network or pick up a
> stale session instead of the one you just approved. Get a second (free)
> project ID from [cloud.reown.com](https://cloud.reown.com) for
> `JoeyAdapter` specifically.

## Limitation: `signMessage` is not supported

Joey's documented XRPL methods (`xrpl_signTransaction`,
`xrpl_signTransactionFor`, `xrpl_signTransactionBulk`) are all
transaction-signing calls - there is no message-signing equivalent. Rather
than faking `signMessage` with a signed dummy transaction, `JoeyAdapter`
throws the standard xrpl-connect "unsupported method" error:

```typescript
try {
  await walletManager.signMessage('Sign in to My App');
} catch (error) {
  // error.code === WalletErrorCode.UNSUPPORTED_METHOD
  console.error(error.message);
  // "Message signing is not supported by Joey Wallet. Please use Xaman,
  //  Crossmark, or GemWallet for signing messages."
}
```

This matters in particular for sign-in-with-wallet flows that assume every
adapter supports `signMessage` - Joey is the first bundled adapter that
doesn't, so make sure to catch this case (or hide the `signMessage` action
for Joey) rather than being surprised by it in production.

## Resources

- [Joey Wallet](https://joeywallet.xyz)
- [Joey Wallet Developer Docs](https://docs.joeywallet.xyz)
- [XRPL Connect Documentation](https://github.com/XRPL-Commons/xrpl-connect)

## License

MIT License

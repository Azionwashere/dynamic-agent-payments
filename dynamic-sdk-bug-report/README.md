# signTransaction bug — fails for wallets created in a previous session

## Bug

`signTransaction()` throws `TypeError: Cannot read properties of undefined (reading 'toLowerCase')` when used with a wallet that was created in a **previous** SDK session. `signTypedData()` works fine with the same wallet and same session.

## Versions

- `@dynamic-labs-wallet/node`: 0.0.320
- `@dynamic-labs-wallet/node-evm`: 0.0.320

## Reproduce

```bash
cp .env.example .env   # fill in DYNAMIC_ENVIRONMENT_ID + DYNAMIC_AUTH_TOKEN
npm install
npm run repro          # first run: creates a wallet
npm run repro          # second run: reproduces the bug
```

**First run** creates a wallet with `TWO_OF_TWO` + `backUpToClientShareService: true` and saves the address to `.wallet-address`.

**Second run** uses that saved address. `signTypedData` succeeds, `signTransaction` fails.

## Expected output (second run)

```
1. getWalletByAddress (public API)...
   ✅ Found wallet: 8af6ffdd-...

2. signTypedData...
   ✅ Success: 0x9c8d3416dc...

3. signTransaction...
   ✅ Success: 0x02f8...
```

## Actual output (second run)

```
1. getWalletByAddress (public API)...
   ✅ Found wallet: 8af6ffdd-...

2. signTypedData...
   ✅ Success: 0x9c8d3416dc...

3. signTransaction...
   ❌ Failed: Cannot read properties of undefined (reading 'toLowerCase')
   Stack: at node/index.esm.js:1535:223
          at Array.find
          at DynamicEvmWalletClient.getWalletByAddress
```

## Root cause

`signTransaction` → `verifyPassword` → `getWallet` → `getWalletByAddress` (internal fallback)

The internal fallback at `node/index.esm.js:1535` iterates `user.verifiedCredentials` and does:

```js
vc.walletName === 'dynamicwaas' && vc.address.toLowerCase() === accountAddress.toLowerCase()
```

Some credentials in the array have `vc.address === undefined`, causing the crash.

The **public** `getWalletByAddress()` API (which uses a different code path via the waas API) works fine for the same wallet.

## Suggested fix

```diff
- vc.address.toLowerCase() === accountAddress.toLowerCase()
+ vc.address?.toLowerCase() === accountAddress.toLowerCase()
```

At both line 1442 and line 1535 in `node/index.esm.js` (and the corresponding lines in `index.cjs.js`).

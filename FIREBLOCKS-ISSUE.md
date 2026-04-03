# Fireblocks Settlement Issue: SIGNER_NOT_FOUND

## Problem

The x402 facilitator successfully verifies payment signatures, but on-chain settlement via Fireblocks fails with:

```
Fireblocks transaction b0efcfd4-bc8c-4c9f-84b6-c54669f7a54c was not completed successfully.
Final Status: FAILED (SIGNER_NOT_FOUND)
```

## Context

The facilitator calls `transferWithAuthorization` on the USDC contract (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) on Base mainnet (chain 8453). The transaction is sent from the facilitator's Fireblocks vault address (`0x634fF21c8d3f4EfAc28daD3621A32E003816c353`).

## Fireblocks Configuration

- **API Key:** `fe93a33b-bf0d-4442-9471-591e46515756` (rotate after fixing)
- **Vault Account ID:** 175 (name: "Deposits")
- **Vault Assets:** BASECHAIN_ETH (0.001 ETH), USDC_BASECHAIN_ETH_5I5C (32.96 USDC)
- **Deposit Address:** `0x634fF21c8d3f4EfAc28daD3621A32E003816c353`

## What to Check

1. **API User Permissions:** The API user linked to key `fe93a33b-...` must have permission to sign transactions from vault 175. Check the API user's role in Fireblocks console → Settings → Users → API Users. It needs "Signer" role or equivalent.

2. **Transaction Signing Policy (TAP):** Fireblocks TAP rules may be blocking the transaction. Check if there's a policy that allows transactions:
   - From vault 175
   - To external contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC)
   - On Base network (BASECHAIN_ETH)

3. **Asset Configuration:** The vault has `USDC_BASECHAIN_ETH_5I5C` — verify this is the correct USDC asset ID for Base mainnet in Fireblocks. The settlement needs to call the USDC contract, which requires ETH for gas.

4. **Gas Balance:** The vault has 0.001 ETH on Base — this should be enough for a `transferWithAuthorization` call (~65k gas), but verify it hasn't been depleted.

5. **CSR Key Pairing:** The API key was created with a CSR generated locally. Verify the CSR was properly paired — if the key file doesn't match the API user, all signing will fail with SIGNER_NOT_FOUND.

## The Exact Transaction That Failed

```json
{
  "method": "eth_sendTransaction",
  "params": [{
    "from": "0x634ff21c8d3f4efac28dad3621a32e003816c353",
    "to": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "gas": "0x15287",
    "data": "0xe3ee160e000000000000000000000000652ab89feb3de32a3c11fae8a6e5e4eb884d29c1000000000000000000000000634ff21c8d3f4efac28dad3621a32e003816c35300000000000000000000000000000000000000000000000000000000000186a0..."
  }]
}
```

This is a call to USDC's `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` — a gasless meta-transaction where the agent signed the authorization and the facilitator executes it.

## Resolution

Once the Fireblocks signing is working, the full end-to-end flow should complete:
1. Agent hits merchant → gets 402
2. Agent swaps ETH → USDC via Dynamic Checkout API (**working**)
3. Agent signs x402 payment → facilitator verifies (**working**)
4. Facilitator settles on-chain via Fireblocks (**blocked here**)
5. Agent gets access

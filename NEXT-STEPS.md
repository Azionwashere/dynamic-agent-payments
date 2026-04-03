# Next Steps

## Current Status

| Phase | Status |
|-------|--------|
| Wallet creation (Dynamic MPC) | ✅ Working |
| Balance checking | ✅ Working |
| Checkout API swap (ETH→USDC on Base) | ✅ Working (real mainnet tx) |
| x402 EIP-712 signing | ✅ Working |
| MPP protocol (parse + credential) | ✅ Working |
| Facilitator signature verification | ✅ Working (after token name fix) |
| Facilitator on-chain settlement | ❌ Blocked — Fireblocks SIGNER_NOT_FOUND |
| MCP server | ✅ Built, 4 tools registered |
| Claude Code skill | ✅ Written |
| Dashboard | ✅ Working |
| Unit tests | ✅ 43 passing |

## Three Paths Forward (pick one or more)

### Path A: Fix Fireblocks → Complete E2E with this facilitator
- Fix the Fireblocks signing issue (see FIREBLOCKS-ISSUE.md)
- Re-run `npx tsx test-full-e2e.ts`
- Should complete the full flow: swap → sign → settle → gold
- **Effort:** depends on Fireblocks team
- **Proves:** full vertical integration with Dynamic + Fireblocks facilitator

### Path B: Test with Coinbase's public x402 facilitator
- Our code already supports Coinbase-style x402 (PAYMENT-REQUIRED header)
- Find a public x402-protected endpoint (e.g., from x402.org examples)
- No Fireblocks needed — Coinbase's facilitator handles settlement
- **Effort:** ~30 min to find an endpoint and test
- **Proves:** our agent works with any x402 facilitator, not just this one

### Path C: Ship the MCP server + skill as a usable tool
- The MCP server is built and compiles. The skill is written.
- Wire it into Claude Code's MCP config and test with a real agent conversation
- The swap + sign flow works — just mock or defer the settlement step
- **Effort:** ~1 hour
- **Proves:** the product works as an installable tool for agent operators

## Recommended Order

**Path C first** — ship the MCP tool so people can use it. The swap + sign flow is the value; settlement is the facilitator's job.

**Path A or B in parallel** — fix Fireblocks config or test with Coinbase's facilitator to prove full settlement.

## Key Files

| File | What |
|------|------|
| `src/lib/` | Core library (checkout, x402, wallet, events) |
| `src/mcp/server.ts` | MCP server with 4 tools |
| `skill/SKILL.md` | Claude Code skill definition |
| `src/dashboard/` | Activity feed UI |
| `test-full-e2e.ts` | End-to-end test (swap + pay) |
| `FIREBLOCKS-ISSUE.md` | Instructions for fixing settlement |
| `.env` | Credentials (don't commit) |

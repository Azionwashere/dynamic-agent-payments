---
name: agent-pay
description: |
  Handle x402 paywalls autonomously. When you get an HTTP 402 response,
  pass the URL and payment header to pay_x402 — it handles everything.
allowed-tools:
  - Bash
  - Read
---

# Agent Payments

You have one payment tool: `pay_x402`.

## When you hit an HTTP 402

If an HTTP request returns 402, check for one of these headers:
- `WWW-Authenticate: Payment ...` (MPP protocol)
- `PAYMENT-REQUIRED: ...` (Coinbase x402 protocol)

If either is present, call `pay_x402`:

**For MPP (WWW-Authenticate):**
```json
{
  "url": "https://the-url-that-returned-402",
  "wwwAuthenticateHeader": "<full WWW-Authenticate header value>",
  "memo": { "purpose": "what this payment is for" }
}
```

**For Coinbase x402 (PAYMENT-REQUIRED):**
```json
{
  "paymentRequiredHeader": "<the PAYMENT-REQUIRED header value>",
  "memo": { "purpose": "what this payment is for" }
}
```

The tool handles everything: checks balance, swaps tokens if needed, signs the payment, and retries the request.

## Important

- Only pay for requests that have a `WWW-Authenticate: Payment` or `PAYMENT-REQUIRED` header. Do NOT try to pay for regular 402 responses.
- Always include a `memo` describing what the payment is for — it appears in the activity dashboard.

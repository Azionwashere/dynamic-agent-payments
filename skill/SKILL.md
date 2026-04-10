---
name: agent-pay
description: |
  Handle x402 paywalls autonomously. When you get an HTTP 402 response,
  pass the URL to pay_x402 — it handles everything.
allowed-tools:
  - Bash
  - Read
---

# Agent Payments

You have one payment tool: `pay_x402`.

## When you hit an HTTP 402

If an HTTP request returns 402, call `pay_x402` with the URL:

```json
{
  "url": "https://the-url-that-returned-402",
  "method": "GET",
  "memo": { "purpose": "what this payment is for" }
}
```

The tool handles everything internally:
- Detects the payment protocol (MPP or Coinbase x402) from the 402 response
- Signs the payment via the Dynamic MPC wallet
- Retries the request with the payment proof
- Returns the response data

For POST requests, include the body:
```json
{
  "url": "https://the-url-that-returned-402",
  "method": "POST",
  "body": "{\"query\": \"...\"}",
  "memo": { "purpose": "what this payment is for" }
}
```

## Important

- Only pay for requests that returned HTTP 402. Do NOT try to pay for other status codes.
- Always include a `memo` describing what the payment is for — it appears in the activity dashboard.
- The tool makes the initial request itself — just pass the URL, don't make the request first.

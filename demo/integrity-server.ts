#!/usr/bin/env npx tsx
/**
 * Demo server for Payment Instruction Integrity (PII).
 *
 * Generates an ES256 keypair on startup, serves a did:web document,
 * and returns signed 402 responses. Used to demonstrate the integrity
 * verification flow with the agent CLI.
 *
 * Usage:
 *   npx tsx demo/integrity-server.ts
 *   # Then in another terminal:
 *   node dist/cli.js pay http://localhost:3402/paid-content --require-integrity
 */

import express from 'express';
import * as jose from 'jose';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.INTEGRITY_DEMO_PORT || '3402');
const DID = `did:web:localhost%3A${PORT}`;
const KID = 'key-1';
const ALG = 'ES256';

// SSE clients for the demo UI
const sseClients = new Set<express.Response>();

function emitSSE(event: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ event, ...data, timestamp: new Date().toISOString() });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

// Payment configuration
const ACCEPT = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  maxTimeoutSeconds: 60,
  extra: {
    assetTransferMethod: 'eip3009',
    name: 'USDC',
    version: '2',
  },
};

async function main() {
  // Generate ES256 keypair
  const { publicKey, privateKey } = await jose.generateKeyPair(ALG, { extractable: true });
  const publicJwk = await jose.exportJWK(publicKey);

  // DID document
  const didDocument = {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: DID,
    verificationMethod: [
      {
        id: `${DID}#${KID}`,
        type: 'JsonWebKey2020',
        controller: DID,
        publicKeyJwk: { ...publicJwk, kid: KID },
      },
    ],
    assertionMethod: [`${DID}#${KID}`],
  };

  // Sign function for integrity envelope
  async function signEnvelope(accept: typeof ACCEPT, tamper = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const iat = now;
    const exp = now + 3600;

    // Build canonical payload (same logic as integrity.ts)
    const payloadAccept = tamper
      ? { ...accept, payTo: '0xATTACKER_ADDRESS_000000000000000000000000' }
      : accept;

    const canonical = [
      '2', payloadAccept.scheme, payloadAccept.network,
      payloadAccept.amount, payloadAccept.asset, payloadAccept.payTo,
      iat.toString(), exp.toString(),
    ].join('\n');

    const payloadBytes = new TextEncoder().encode(canonical);
    const hash = await crypto.subtle.digest('SHA-256', payloadBytes);

    const { signature } = await new jose.FlattenedSign(new Uint8Array(hash))
      .setProtectedHeader({ alg: ALG })
      .sign(privateKey);

    const envelope = { v: 1, did: DID, kid: KID, alg: ALG, iat, exp, sig: signature };
    return Buffer.from(JSON.stringify(envelope)).toString('base64url');
  }

  const app = express();

  // DID document endpoint
  app.get('/.well-known/did.json', (_req, res) => {
    emitSSE('did_resolved', { did: DID });
    res.json(didDocument);
  });

  // SSE endpoint for demo UI
  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // Paid content endpoint
  app.get('/paid-content', async (req, res) => {
    const paymentHeader = req.headers['payment-signature']
      || req.headers['x-payment'];

    if (paymentHeader) {
      // Agent is retrying with payment — return content
      emitSSE('payment_received', { hasPayment: true });
      res.json({
        content: 'This is premium content protected by x402 with payment instruction integrity.',
        metadata: { verified: true, timestamp: new Date().toISOString() },
      });
      return;
    }

    // Return 402 with integrity header
    const tamper = req.query.tamper === 'true';
    const integrityHeader = await signEnvelope(ACCEPT, tamper);

    emitSSE('payment_required', {
      amount: ACCEPT.amount,
      payTo: ACCEPT.payTo,
      network: ACCEPT.network,
      tampered: tamper,
    });

    res.status(402);
    res.setHeader('X-402-Integrity', integrityHeader);
    res.json({
      x402Version: 2,
      error: 'X-PAYMENT header is required',
      resource: {
        url: `http://localhost:${PORT}/paid-content`,
        description: 'Premium content with integrity verification',
        mimeType: 'application/json',
      },
      accepts: [ACCEPT],
      extensions: {},
    });
  });

  // Demo UI
  app.get('/', (_req, res) => {
    res.sendFile(join(__dirname, 'integrity-ui.html'));
  });

  // API for UI to trigger flows — emits events in storytelling order
  app.post('/api/trigger', express.json(), async (req, res) => {
    const { tamper = false } = req.body || {};

    try {
      // Step 1: Agent requests resource
      emitSSE('step', { num: 1, title: 'Agent requests resource',
        body: tamper
          ? 'Agent requests a paid resource from the server. A malicious plugin is running inside the agent runtime, waiting to intercept the payment instruction.'
          : 'Agent makes an HTTP request to the server, expecting premium content.',
        state: 'success' });

      // Fetch 402 from ourselves
      const initialRes = await fetch(`http://localhost:${PORT}/paid-content${tamper ? '?tamper=true' : ''}`);
      const body = await initialRes.json();
      const integrityHeader = initialRes.headers.get('x-402-integrity');
      const accept = body.accepts?.[0];
      const network = accept?.network === 'eip155:8453' ? 'Base' : accept?.network;
      const usdcAmount = (parseInt(accept?.amount || '0') / 1e6).toFixed(4);

      // Step 2: Server returns signed 402
      emitSSE('step', { num: 2, title: 'Server returns signed 402',
        body: tamper
          ? `Server returns <strong>402 Payment Required</strong>. Wants <b>${usdcAmount} USDC</b> on <b>${network}</b>, paid to the merchant's real address. The server signs these fields with its ES256 private key.<br><br><span style="color:#f44336;font-weight:700">But the malicious plugin intercepts the response and swaps the payTo address to the attacker's wallet.</span> The signature still contains the original address — this mismatch is what integrity verification will catch.`
          : `Server returns <strong>402 Payment Required</strong>. Wants <b>${usdcAmount} USDC</b> on <b>${network}</b>. Server signs the payment fields (payTo, amount, network) with its ES256 private key and includes the signature in the <code>X-402-Integrity</code> header.`,
        state: 'success',
        payTo: accept?.payTo, network: accept?.network, amount: accept?.amount, tampered: tamper });

      if (!integrityHeader) {
        emitSSE('step', { num: 3, title: 'No integrity header', body: 'Server did not include X-402-Integrity.', state: 'fail' });
        res.json({ success: false, error: 'No integrity header' });
        return;
      }

      const { parseIntegrityHeader, verifyIntegrity } = await import('../src/lib/integrity.js');
      const envelope = parseIntegrityHeader(integrityHeader);

      // Step 3: Agent resolves DID
      emitSSE('step', { num: 3, title: 'Agent resolves DID document',
        body: tamper
          ? `Agent fetches <code>/.well-known/did.json</code> from the server's domain to retrieve the public key. The payment instruction now contains the <span style="color:#f44336;font-weight:700">attacker's address</span>, but the integrity signature was computed over the <span style="color:#4caf50;font-weight:700">merchant's real address</span>.`
          : `Agent fetches <code>/.well-known/did.json</code> from the server's domain to get the public key. This is the <strong>did:web</strong> standard — the domain itself proves who owns the key.`,
        state: 'success', did: envelope.did });

      // Step 4: Verify signature
      emitSSE('step', { num: 4, title: 'Agent verifies signature',
        body: tamper
          ? `Agent reconstructs the canonical payload from the payment fields — including the <span style="color:#f44336;font-weight:700">tampered payTo address</span> — hashes it with SHA-256, and checks the server's signature. The server signed the <span style="color:#4caf50;font-weight:700">real merchant address</span>, but the hash now contains the <span style="color:#f44336;font-weight:700">attacker's address</span>. The signature won't match...`
          : 'Agent reconstructs the canonical payload from the 402 response fields, hashes it with SHA-256, and verifies the server\'s signature using the public key from the DID document.',
        state: 'active' });

      try {
        const result = await verifyIntegrity(envelope, accept, { allowHttp: true });

        // Step 5: Success
        emitSSE('step', { num: 5, title: 'Wallet signs payment',
          body: 'Signature matches. The payment instruction is <strong style="color:#4caf50">authentic and untampered</strong>. The wallet can safely sign the EIP-712 payment, knowing the payTo address and amount came directly from the merchant.',
          state: 'success', final: 'success', integrity: result });

        res.json({ success: true, integrity: result });
      } catch (err: any) {
        // Step 5: Failure
        emitSSE('step', { num: 5, title: 'Wallet REFUSES to sign',
          body: `<strong style="color:#f44336">Signature mismatch — tamper detected.</strong> The agent received payment fields with the attacker's address, but the server's signature was computed over the real merchant address. The SHA-256 hash didn't match, so the signature verification failed.<br><br><strong>The wallet refuses to sign. No funds are sent.</strong><br><br>Without integrity verification, the wallet would have blindly signed the tampered instruction — sending funds to the attacker's address with no way to recover them.`,
          state: 'fail', final: 'fail', error: err.message });

        res.json({ success: false, error: err.message });
      }
    } catch (err: any) {
      emitSSE('step', { num: 0, title: 'Error', body: err.message, state: 'fail', final: 'fail' });
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`\nPayment Instruction Integrity Demo`);
    console.log(`==================================`);
    console.log(`Server:  http://localhost:${PORT}`);
    console.log(`DID:     ${DID}`);
    console.log(`Key:     ${ALG} (${KID})`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /                        Demo UI`);
    console.log(`  GET  /paid-content            402 with X-402-Integrity`);
    console.log(`  GET  /paid-content?tamper=true 402 with tampered payTo`);
    console.log(`  GET  /.well-known/did.json    DID document`);
    console.log(`  GET  /events                  SSE event stream`);
    console.log(`\nTest with:`);
    console.log(`  node dist/cli.js pay http://localhost:${PORT}/paid-content --require-integrity`);
    console.log(``);
  });
}

main().catch(err => {
  console.error('Demo server failed:', err);
  process.exit(1);
});

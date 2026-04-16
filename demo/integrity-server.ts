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

  // API for UI to trigger flows
  app.post('/api/trigger', express.json(), async (req, res) => {
    const { tamper = false } = req.body || {};
    emitSSE('flow_started', { tamper });

    // Simulate the flow by making a request to ourselves
    try {
      const initialRes = await fetch(`http://localhost:${PORT}/paid-content${tamper ? '?tamper=true' : ''}`);
      const body = await initialRes.json();
      const integrityHeader = initialRes.headers.get('x-402-integrity');

      emitSSE('server_signed', {
        hasIntegrity: !!integrityHeader,
        tamper,
        accept: body.accepts?.[0],
      });

      // Verify integrity client-side
      if (integrityHeader) {
        const { parseIntegrityHeader, verifyIntegrity } = await import('../src/lib/integrity.js');
        const envelope = parseIntegrityHeader(integrityHeader);

        emitSSE('agent_verifying', { did: envelope.did, kid: envelope.kid });

        try {
          const result = await verifyIntegrity(envelope, body.accepts[0], { allowHttp: true });
          emitSSE('integrity_result', { verified: true, ...result });
          res.json({ success: true, integrity: result });
        } catch (err: any) {
          emitSSE('integrity_result', { verified: false, error: err.message });
          res.json({ success: false, error: err.message });
        }
      }
    } catch (err: any) {
      emitSSE('flow_error', { error: err.message });
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

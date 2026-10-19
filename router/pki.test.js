'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tls = require('node:tls')
const { execFileSync } = require('node:child_process')
const P = require('./pki')

const HOST = 'api.anthropic.com'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pki-'))

// Handshake against a server presenting `cert`/`key`, trusting only `ca`; resolves null on success or the error code
function handshake({ cert, key, ca, servername }) {
  return new Promise((resolve) => {
    const server = tls.createServer({ cert, key }, (s) => s.end())
    server.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: server.address().port, ca, servername, rejectUnauthorized: true }, () => {
        c.end()
        server.close()
        resolve(null)
      })
      c.on('error', (e) => {
        server.close()
        resolve(`${e.code}: ${e.message}`)
      })
    })
  })
}

// A leaf for `host` signed with the CA's private key by OpenSSL, so the test does not reuse the code under test
function signRogueLeaf(out, keys, host) {
  const dir = tmp()
  const f = (n) => path.join(dir, n)
  fs.writeFileSync(f('ca.pem'), out.caPem)
  fs.writeFileSync(f('ca.key'), out._caPrivate.export({ type: 'pkcs8', format: 'pem' }))
  fs.writeFileSync(f('leaf.key'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  fs.writeFileSync(f('ext.cnf'), `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`)
  execFileSync('openssl', ['req', '-new', '-key', f('leaf.key'), '-subj', `/CN=${host}`, '-out', f('leaf.csr')], { stdio: 'ignore' })
  execFileSync('openssl', ['x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '30', '-extfile', f('ext.cnf'), '-out', f('leaf.pem')], { stdio: 'ignore' })
  return fs.readFileSync(f('leaf.pem'), 'utf8')
}

test('issued certificates parse and carry the intended constraints', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const out = P.issue({ hosts: [HOST], now })
  const ca = new crypto.X509Certificate(out.caPem)
  const leaf = new crypto.X509Certificate(out.leafPem)
  assert.strictEqual(ca.ca, true)
  assert.strictEqual(leaf.ca, false)
  assert.ok(leaf.checkHost(HOST))
  assert.strictEqual(leaf.checkHost('claude.ai'), undefined)
  assert.ok(leaf.verify(ca.publicKey), 'leaf is signed by the CA')
  assert.ok(ca.verify(ca.publicKey), 'CA is self-signed')
  assert.ok(leaf.checkIssued(ca))
  assert.ok(Date.parse(leaf.validTo) <= Date.parse(ca.validTo))
  assert.ok(Date.parse(ca.validFrom) < now, 'valid from slightly before issue time')
  assert.ok(!out.caPem.includes('PRIVATE KEY'), 'the CA key is never exported')
  assert.ok(out.leafKeyPem.includes('PRIVATE KEY'))
})

test('a real TLS handshake succeeds for api.anthropic.com when only the CA is trusted', async () => {
  const out = P.issue({ hosts: [HOST] })
  assert.strictEqual(await handshake({ cert: out.leafPem, key: out.leafKeyPem, ca: out.caPem, servername: HOST }), null)
})

test('the same leaf is refused for any other host name', async () => {
  const out = P.issue({ hosts: [HOST] })
  const code = await handshake({ cert: out.leafPem, key: out.leafKeyPem, ca: out.caPem, servername: 'claude.ai' })
  assert.match(String(code), /ERR_TLS_CERT_ALTNAME_INVALID/)
})

test('without the CA the certificate is not trusted', async () => {
  const out = P.issue({ hosts: [HOST] })
  const code = await handshake({ cert: out.leafPem, key: out.leafKeyPem, ca: undefined, servername: HOST })
  assert.match(String(code), /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/)
})

test('the CA name constraint stops it from vouching for other hosts, even if its key leaked', async () => {
  const out = P.issue({ hosts: [HOST], _keepCaKey: true })
  const rogueKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const rogue = signRogueLeaf(out, rogueKeys, 'example.com')
  const code = await handshake({ cert: rogue, key: rogueKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: out.caPem, servername: 'example.com' })
  assert.notStrictEqual(code, null, 'a leaf outside the constraint must be rejected')
  assert.match(String(code), /permitted subtree violation/i, 'rejected for the right reason, not some other defect')
})

test('OpenSSL agrees the issued chain is valid', () => {
  const out = P.issue({ hosts: [HOST] })
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'ca.pem'), out.caPem)
  fs.writeFileSync(path.join(dir, 'leaf.pem'), out.leafPem)
  const r = execFileSync('openssl', ['verify', '-CAfile', path.join(dir, 'ca.pem'), '-verify_hostname', HOST, path.join(dir, 'leaf.pem')], { encoding: 'utf8' })
  assert.match(r, /: OK/)
})

test('files: ensure creates them once, reports status, and renews only when due', () => {
  const dir = tmp()
  assert.strictEqual(P.status(dir).complete, false)
  assert.strictEqual(P.loadLeaf(dir), null, 'nothing to load yet')
  const a = P.ensure(dir, { hosts: [HOST] })
  assert.strictEqual(a.issued, true)
  assert.strictEqual(a.complete, true)
  const caBefore = fs.readFileSync(a.ca, 'utf8')
  const b = P.ensure(dir, { hosts: [HOST] })
  assert.strictEqual(b.issued, false, 'a healthy set is left alone')
  assert.strictEqual(fs.readFileSync(b.ca, 'utf8'), caBefore)
  const later = Date.now() + 380 * P.DAY
  assert.strictEqual(P.status(dir, { now: later }).renewDue, true)
  assert.strictEqual(P.ensure(dir, { hosts: [HOST], now: later }).issued, true)
  assert.ok(P.loadLeaf(dir), 'loads when valid')
  assert.strictEqual(P.loadLeaf(dir, { now: Date.now() + 5000 * P.DAY }), null, 'expired certificate is not served')
})

test('bad host lists are refused', () => {
  assert.throws(() => P.issue({ hosts: [] }))
  assert.throws(() => P.issue({ hosts: ['api.anthropic.com;rm'] }))
})

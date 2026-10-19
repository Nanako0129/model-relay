'use strict'
// Local certificate authority for the relay's HTTPS proxy mode. Zero dependencies.
//
// Why it exists: Remote Control only starts when Claude Code talks to api.anthropic.com, so the relay cannot be
// the base URL there. Instead Claude Code uses the relay as its HTTPS proxy and the relay answers for
// api.anthropic.com with a certificate that Claude Code trusts through NODE_EXTRA_CA_CERTS.
//
// The trust is kept as small as possible:
//   - the CA carries a critical name constraint, so a verifier rejects anything it signs outside the allowed hosts;
//   - the CA private key never touches disk, it signs one leaf certificate in memory and is dropped;
//   - the CA file is only loaded by processes that opt in with NODE_EXTRA_CA_CERTS, never by the Windows store.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// ---------- DER encoding (just the pieces X.509 needs) ----------

const lenBytes = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]))
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body])
}
const seq = (...p) => tlv(0x30, ...p)
const set = (...p) => tlv(0x31, ...p)
const octet = (...p) => tlv(0x04, ...p)
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
const smallInt = (n) => tlv(0x02, Buffer.from([n]))
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
const ia5 = (tag, s) => tlv(tag, Buffer.from(s, 'ascii'))
const bits = (unused, bytes) => tlv(0x03, Buffer.from([unused]), Buffer.from(bytes))
const ctx = (n, ...p) => tlv(0xa0 + n, ...p)

function oid(dotted) {
  const a = dotted.split('.').map(Number)
  const out = [40 * a[0] + a[1]]
  for (const n of a.slice(2)) {
    const chunk = [n & 0x7f]
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

// A random positive serial: 16 bytes with the top bit cleared so DER never needs a sign byte
function serial() {
  const b = crypto.randomBytes(16)
  b[0] &= 0x7f
  if (b[0] === 0) b[0] = 1
  return tlv(0x02, b)
}

function utcTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'))
}

const OID = {
  cn: '2.5.4.3',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ski: '2.5.29.14',
  keyUsage: '2.5.29.15',
  san: '2.5.29.17',
  basic: '2.5.29.19',
  nameConstraints: '2.5.29.30',
  aki: '2.5.29.35',
  eku: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
}

const name = (cn) => seq(set(seq(oid(OID.cn), utf8(cn))))
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value))
const sigAlg = () => seq(oid(OID.ecdsaSha256))
const keyId = (spkiDer) => crypto.createHash('sha1').update(spkiDer).digest()
const spki = (publicKey) => publicKey.export({ type: 'spki', format: 'der' })
const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

function certificate({ subject, issuer, subjectKey, issuerPrivate, issuerKeyId, notBefore, notAfter, extensions }) {
  const subjectSpki = spki(subjectKey)
  const tbs = seq(
    ctx(0, smallInt(2)),
    serial(),
    sigAlg(),
    name(issuer),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(subject),
    subjectSpki,
    ctx(3, seq(
      extension(OID.ski, false, octet(keyId(subjectSpki))),
      extension(OID.aki, false, seq(tlv(0x80, issuerKeyId || keyId(subjectSpki)))),
      ...extensions,
    )),
  )
  const signature = crypto.sign('sha256', tbs, issuerPrivate) // DER-encoded ECDSA, which is what X.509 expects
  return seq(tbs, sigAlg(), bits(0, signature))
}

const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`

// ---------- Issuing ----------

const DAY = 86400000
const DEFAULT_CA_DAYS = 1095
const DEFAULT_LEAF_DAYS = 397
const ca = (host) => `model-relay local CA (only for ${host})`

/**
 * Make a CA that may only vouch for `hosts`, and one leaf certificate for hosts[0] signed by it.
 * The CA private key exists only inside this call.
 * @returns {{ caPem: string, leafPem: string, leafKeyPem: string }}
 */
function issue({ hosts, now = Date.now(), caDays = DEFAULT_CA_DAYS, leafDays = DEFAULT_LEAF_DAYS, _keepCaKey = false }) {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((h) => !/^[a-z0-9.-]+$/.test(h))) throw new Error('hosts must be plain DNS names')
  const caKeys = newKey()
  const leafKeys = newKey()
  const notBefore = now - 5 * 60000 // tolerate small clock skew
  const caSpki = spki(caKeys.publicKey)
  const permitted = tlv(0xa0, ...hosts.map((h) => seq(ia5(0x82, h))))

  const caDer = certificate({
    subject: ca(hosts[0]),
    issuer: ca(hosts[0]),
    subjectKey: caKeys.publicKey,
    issuerPrivate: caKeys.privateKey,
    notBefore,
    notAfter: now + caDays * DAY,
    extensions: [
      extension(OID.basic, true, seq(bool(true), smallInt(0))),
      extension(OID.keyUsage, true, bits(1, [0x06])), // keyCertSign, cRLSign
      extension(OID.nameConstraints, true, seq(permitted)),
    ],
  })
  const leafDer = certificate({
    subject: hosts[0],
    issuer: ca(hosts[0]),
    subjectKey: leafKeys.publicKey,
    issuerPrivate: caKeys.privateKey,
    issuerKeyId: keyId(caSpki),
    notBefore,
    notAfter: Math.min(now + leafDays * DAY, now + caDays * DAY),
    extensions: [
      extension(OID.basic, true, seq()),
      extension(OID.keyUsage, true, bits(7, [0x80])), // digitalSignature
      extension(OID.eku, false, seq(oid(OID.serverAuth))),
      extension(OID.san, false, seq(...hosts.map((h) => ia5(0x82, h)))),
    ],
  })
  const out = {
    caPem: pem('CERTIFICATE', caDer),
    leafPem: pem('CERTIFICATE', leafDer),
    leafKeyPem: leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
  // Test seam only: lets a unit test sign a rogue certificate to prove the name constraint bites
  if (_keepCaKey) out._caPrivate = caKeys.privateKey
  return out
}

// ---------- Files ----------

const FILES = { ca: 'ca.pem', leaf: 'leaf.pem', key: 'leaf.key' }
const pkiDir = (configDir) => path.join(configDir, 'model-relay-pki')
const paths = (configDir) => {
  const d = pkiDir(configDir)
  return { dir: d, ca: path.join(d, FILES.ca), leaf: path.join(d, FILES.leaf), key: path.join(d, FILES.key) }
}

function restrict(file) {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME
      if (user) require('child_process').execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true })
    } else {
      fs.chmodSync(file, 0o600)
    }
  } catch {}
}

function write(configDir, issued) {
  const p = paths(configDir)
  fs.mkdirSync(p.dir, { recursive: true })
  // Key first, so a crash never leaves a leaf without its key
  fs.writeFileSync(p.key, issued.leafKeyPem, { mode: 0o600 })
  restrict(p.key)
  fs.writeFileSync(p.leaf, issued.leafPem)
  fs.writeFileSync(p.ca, issued.caPem)
  return p
}

function describe(file) {
  try {
    const c = new crypto.X509Certificate(fs.readFileSync(file))
    return { subject: c.subject, notBefore: Date.parse(c.validFrom), notAfter: Date.parse(c.validTo), san: c.subjectAltName || '' }
  } catch {
    return null
  }
}

/** What is on disk: whether both files exist, when the leaf stops being valid, and whether it is due for renewal. */
function status(configDir, { now = Date.now(), renewWithinDays = 30 } = {}) {
  const p = paths(configDir)
  const leaf = describe(p.leaf)
  const caInfo = describe(p.ca)
  const complete = Boolean(leaf && caInfo && fs.existsSync(p.key))
  return {
    ...p,
    complete,
    caExpires: caInfo ? caInfo.notAfter : null,
    leafExpires: leaf ? leaf.notAfter : null,
    expired: complete ? leaf.notAfter <= now : false,
    renewDue: complete ? leaf.notAfter - now < renewWithinDays * DAY : true,
  }
}

/** Create the files when missing or due for renewal. Returns the status afterwards and whether it issued new ones. */
function ensure(configDir, { hosts, now = Date.now(), force = false } = {}) {
  const before = status(configDir, { now })
  if (before.complete && !before.renewDue && !force) return { ...before, issued: false }
  write(configDir, issue({ hosts, now }))
  return { ...status(configDir, { now }), issued: true }
}

/** Key and certificate for the TLS listener, or null when the files are missing, unreadable or expired. */
function loadLeaf(configDir, { now = Date.now() } = {}) {
  const s = status(configDir, { now })
  if (!s.complete || s.expired) return null
  try {
    return { key: fs.readFileSync(s.key), cert: fs.readFileSync(s.leaf), expires: s.leafExpires }
  } catch {
    return null
  }
}

module.exports = { issue, paths, status, ensure, loadLeaf, DAY }

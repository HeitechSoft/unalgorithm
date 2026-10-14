/**
 * A software WebAuthn authenticator for tests of passkey sign-in (CL3-14), on `node:crypto` only: one EC P-256 key
 * pair, a random 16-byte credential id, the all-zero AAGUID (or a model's) and a sign count that stays 0. `register` and
 * `authenticate` answer the options Better Auth's passkey routes hand out with the JSON a browser's
 * `navigator.credentials.create` and `get` results serialise to (WebAuthn Level 3 `toJSON()`): no attestation (`none`),
 * user presence and verification set. The CBOR is written by hand for these fixed shapes.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export interface SoftAuthenticatorOptions {
  /** The relying party's id, whose SHA-256 starts the authenticator data. */
  rpId: string;
  /** The origin `clientDataJSON` names: the page's, as a browser reports it. */
  origin: string;
  /**
   * The credential id to answer with, base64url. Default: a new random one. Another authenticator's id makes this one
   * claim that credential while signing with its own, different key.
   */
  credentialId?: string;
  /**
   * The authenticator model's id (AAGUID) its registrations report, as a UUID. Default: all zeros, which
   * privacy-preserving authenticators report and which names no model.
   */
  aaguid?: string;
}

/** What `register` reads of the registration options the server hands out (`generate-register-options`). */
export interface RegistrationOptionsJSON {
  challenge: string;
  user: { id: string };
}

/** What `authenticate` reads of the authentication options (`generate-authenticate-options`). */
export interface AuthenticationOptionsJSON {
  challenge: string;
}

export interface SoftAuthenticator {
  /** The credential id, base64url, as Better Auth stores it. */
  credentialId: string;
  /** The credential's COSE public key. */
  publicKey: Buffer;
  /** The registration response for `navigator.credentials.create` with these options. */
  register(optionsJSON: RegistrationOptionsJSON): Record<string, unknown>;
  /**
   * The authentication response for `navigator.credentials.get` with these options. `page.origin` is another page the
   * ceremony ran on, which a browser on that site reports (default: the authenticator's own `origin`).
   */
  authenticate(optionsJSON: AuthenticationOptionsJSON, page?: { origin?: string }): Record<string, unknown>;
}

/** Flags: user present (UP) and user verified (UV); attested credential data (AT) when registering. */
const FLAGS_REGISTER = 0x45;
const FLAGS_AUTHENTICATE = 0x05;
/** The AAGUID privacy-preserving authenticators report, which names no authenticator model. */
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

function uint(value: number, bytes: 2 | 4): Buffer {
  const out = Buffer.alloc(bytes);
  if (bytes === 2) out.writeUInt16BE(value);
  else out.writeUInt32BE(value);
  return out;
}

/** A CBOR text string of fewer than 24 bytes. */
const cborText = (text: string): Buffer => Buffer.concat([Buffer.from([0x60 + text.length]), Buffer.from(text)]);

export function softAuthenticator({
  rpId,
  origin,
  credentialId,
  aaguid = ZERO_AAGUID,
}: SoftAuthenticatorOptions): SoftAuthenticator {
  const aaguidBytes = Buffer.from(aaguid.replaceAll('-', ''), 'hex');
  if (aaguidBytes.length !== 16) throw new TypeError('An AAGUID is 16 bytes, written as a UUID.');
  const { privateKey, publicKey: keyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = keyObject.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}.
  const publicKey = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  const id = credentialId ?? randomBytes(16).toString('base64url');
  const rawId = Buffer.from(id, 'base64url');
  const rpIdHash = sha256(rpId);
  const signCount = uint(0, 4);
  /** The user handle the registration options named (already base64url), sent back when authenticating. */
  let userHandle: string | undefined;

  const clientData = (type: 'webauthn.create' | 'webauthn.get', challenge: string, at = origin): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin: at, crossOrigin: false }));

  return {
    credentialId: id,
    publicKey,
    register(optionsJSON) {
      userHandle = optionsJSON.user.id;
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([FLAGS_REGISTER]),
        signCount,
        aaguidBytes,
        uint(rawId.length, 2),
        rawId,
        publicKey,
      ]);
      // {"fmt": "none", "attStmt": {}, "authData": <bytes, 2-byte length>}
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]),
        cborText('fmt'),
        cborText('none'),
        cborText('attStmt'),
        Buffer.from([0xa0]),
        cborText('authData'),
        Buffer.from([0x59]),
        uint(authData.length, 2),
        authData,
      ]);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', optionsJSON.challenge).toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    authenticate(optionsJSON, page = {}) {
      const authData = Buffer.concat([rpIdHash, Buffer.from([FLAGS_AUTHENTICATE]), signCount]);
      const clientDataJSON = clientData('webauthn.get', optionsJSON.challenge, page.origin);
      // ES256 over the authenticator data and the client data's hash; DER, Node's default for EC keys.
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
          ...(userHandle === undefined ? {} : { userHandle }),
        },
        clientExtensionResults: {},
      };
    },
  };
}

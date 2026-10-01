"use client";

/** Zero-knowledge helpers: AES-256-GCM via WebCrypto.
 *  The key is generated in the browser, base64url'd into the link FRAGMENT (#),
 *  and never sent to the server. Fragments are not transmitted in HTTP requests. */

function b64uEncode(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate a fresh 256-bit key, exported as base64url. */
export async function newKeyB64(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return b64uEncode(raw);
}

/** Encrypt bytes with a base64url key → base64 blob (iv||ciphertext). */
export async function encryptBytes(keyB64: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", b64uDecode(keyB64) as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource);
  return b64uEncode(concat(iv, new Uint8Array(ct)).buffer as ArrayBuffer);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/** Decrypt a base64 blob (iv||ct) with a base64url key. */
export async function decryptBytes(keyB64: string, blobB64: string): Promise<Uint8Array> {
  const raw = b64uDecode(blobB64);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const key = await crypto.subtle.importKey("raw", b64uDecode(keyB64) as BufferSource, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct as BufferSource);
  return new Uint8Array(pt);
}

/** SHA-256 digest of raw bytes (for the client-side integrity badge). */
export async function sha256B64u(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return b64uEncode(d);
}

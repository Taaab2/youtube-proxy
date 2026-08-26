"use strict";
/**
 * Copy this file to config.js and fill it in. config.js is git-ignored on purpose —
 * it holds the token and the cookie encryption key, and this repo is public.
 *
 * token: fine-grained personal access token limited to this repository, with one
 * permission — "Actions: Read and write". That covers dispatching the workflow,
 * reading run status and downloading the artifact, and nothing else.
 *
 * The easiest way to fill it in is `python tools/embed_token.py`: it prompts for the
 * token, verifies it against the API, and writes it into config.js split into
 * XOR-obfuscated chunks (see below) instead of as one plain string — reassembled at
 * runtime by _assembleToken(). This is obfuscation, not encryption: the key sits
 * right here in the same file, so it only stops the token from reading as one
 * recognizable string at a glance. Real protection is the token's own scope.
 *
 * To fill the chunks in by hand instead, run:
 *   python -c "
 *   import base64, secrets
 *   token = input('token: ').strip()
 *   key = secrets.token_hex(11)
 *   x = bytes(b ^ ord(key[i % len(key)]) for i, b in enumerate(token.encode()))
 *   b64 = base64.b64encode(x).decode()
 *   n = 5
 *   print([b64[i::n] for i in range(n)])
 *   print(key)
 *   "
 *
 * cookieKey: 64 hex chars. Must be the same value as the COOKIE_KEY repo secret.
 * Generate one with:  python -c "import secrets; print(secrets.token_hex(32))"
 *
 * Everything here is only a default — whatever you set on the options page wins.
 */
const _TK_CHUNKS = [];
const _TK_KEY = "";

function _deinterleave(chunks) {
  const n = chunks.length;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Array(total);
  for (let i = 0; i < n; i += 1) {
    const c = chunks[i];
    for (let j = 0; j < c.length; j += 1) out[i + j * n] = c[j];
  }
  return out.join("");
}

function _assembleToken(chunks, key) {
  if (!chunks.length || !key) return "";
  const b64 = _deinterleave(chunks);
  const bin = atob(b64);
  let out = "";
  for (let i = 0; i < bin.length; i += 1) {
    out += String.fromCharCode(bin.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

const DEFAULT_CONFIG = {
  owner: "your-github-username",
  repo: "youtube-proxy",
  workflow: "download.yml",
  ref: "main",
  get token() {
    return _assembleToken(_TK_CHUNKS, _TK_KEY);
  },
  cookieKey: "",
  // Where the extension pulls CODE updates from (a public repo hosting the clean
  // extension). Leave blank to disable auto-update. This is separate from owner/repo
  // above, which is your personal download backend.
  updateOwner: "",
  updateRepo: ""
};

if (typeof self !== "undefined") self.DEFAULT_CONFIG = DEFAULT_CONFIG;

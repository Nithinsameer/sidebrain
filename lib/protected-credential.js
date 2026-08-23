'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_VOICE_CREDENTIAL_FILE = path.join(os.homedir(), '.config', 'sidebrain', 'voice-command-token');

class ProtectedCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtectedCredentialError';
    this.code = code;
  }
}

function readProtectedCredential(file, { missingCode, label, maximum = 512 } = {}) {
  const directory = path.dirname(file);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0) {
      throw new Error('insecure');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ProtectedCredentialError(missingCode, `${label} is not configured`);
    throw new ProtectedCredentialError(`${missingCode}_insecure`, `${label} credential directory permissions must be 0700`);
  }

  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new ProtectedCredentialError(missingCode, `${label} is not configured`);
    throw new ProtectedCredentialError(`${missingCode}_unavailable`, `${label} credential file is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0) {
    throw new ProtectedCredentialError(`${missingCode}_insecure`, `${label} credential file must be an owned regular 0600 file`);
  }
  const credential = fs.readFileSync(file, 'utf8').trim();
  if (!credential || credential.length > maximum || /[\r\n\u0000]/.test(credential)) {
    throw new ProtectedCredentialError(`${missingCode}_invalid`, `${label} credential file is invalid`);
  }
  return credential;
}

function readVoiceCredential(file = process.env.SIDEBRAIN_VOICE_CREDENTIAL_FILE || DEFAULT_VOICE_CREDENTIAL_FILE) {
  return readProtectedCredential(file, { missingCode: 'voice_not_configured', label: 'Voice command access' });
}

module.exports = {
  DEFAULT_VOICE_CREDENTIAL_FILE,
  ProtectedCredentialError,
  readProtectedCredential,
  readVoiceCredential,
};

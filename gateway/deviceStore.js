import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const DEVICE_NAME_MAX_LENGTH = 80;

const hashToken = (token) => crypto
  .createHash('sha256')
  .update(String(token))
  .digest('hex');

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const publicDevice = (device) => ({
  id: device.id,
  name: device.name,
  createdAt: device.createdAt,
  expiresAt: device.expiresAt,
  revokedAt: device.revokedAt,
});

const normalizeDeviceName = (value) => {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('device_name_required');
  if (name.length > DEVICE_NAME_MAX_LENGTH) throw new Error('device_name_too_long');
  return name;
};

const loadStore = (filePath) => {
  if (!fs.existsSync(filePath)) return [];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Gateway device store: ${error.message}`);
  }

  if (data?.version !== STORE_VERSION || !Array.isArray(data.devices)) {
    throw new Error('Unsupported or invalid Gateway device store');
  }

  return data.devices;
};

export const createDeviceStore = (config, clock = () => Date.now()) => {
  const filePath = path.resolve(config.deviceStorePath);
  const devices = loadStore(filePath);
  let persistence = Promise.resolve();

  const persist = () => {
    const snapshot = `${JSON.stringify({ version: STORE_VERSION, devices }, null, 2)}\n`;
    persistence = persistence
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
          await fs.promises.writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
          await fs.promises.rename(temporaryPath, filePath);
          await fs.promises.chmod(filePath, 0o600);
        } catch (error) {
          await fs.promises.rm(temporaryPath, { force: true });
          throw error;
        }
      });
    return persistence;
  };

  const register = async (name) => {
    const now = Math.floor(clock() / 1000);
    const token = `cmdt_${crypto.randomBytes(32).toString('base64url')}`;
    const device = {
      id: `dev_${crypto.randomBytes(12).toString('base64url')}`,
      name: normalizeDeviceName(name),
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + config.deviceTokenTtlSeconds,
      revokedAt: null,
    };
    devices.push(device);
    try {
      await persist();
    } catch (error) {
      const deviceIndex = devices.findIndex((candidate) => candidate.id === device.id);
      if (deviceIndex >= 0) devices.splice(deviceIndex, 1);
      throw error;
    }
    return { device: publicDevice(device), token };
  };

  const authenticate = (token) => {
    if (!String(token).startsWith('cmdt_')) return false;
    const tokenHash = hashToken(token);
    const now = Math.floor(clock() / 1000);
    return devices.some((device) => (
      device.revokedAt === null
      && device.expiresAt > now
      && safeEqual(device.tokenHash, tokenHash)
    ));
  };

  const list = () => devices.map(publicDevice);

  const revokeDevice = async (device) => {
    if (device.revokedAt === null) {
      device.revokedAt = Math.floor(clock() / 1000);
      await persist();
    }
    return publicDevice(device);
  };

  const revoke = async (id) => {
    const device = devices.find((candidate) => candidate.id === id);
    if (!device) return null;
    return revokeDevice(device);
  };

  const revokeToken = async (token) => {
    const tokenHash = hashToken(token);
    const device = devices.find((candidate) => safeEqual(candidate.tokenHash, tokenHash));
    if (!device || device.revokedAt !== null) return null;
    return revokeDevice(device);
  };

  return {
    authenticate,
    list,
    register,
    revoke,
    revokeToken,
  };
};

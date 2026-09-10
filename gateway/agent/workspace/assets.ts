import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AgentHttpError } from '../store.js';
import type { Attachment } from '../store.js';
import { ComfyAdapter, ComfyRequestError } from '../../workflow/comfyAdapter.js';
import { WorkspaceRepository } from './repository.js';
import { locateOutputs } from './outputs.js';
import { digest } from './digest.js';
import type { Asset, AssetLocation, InputManifestEntry, MediaKind } from './types.js';

const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const mimeExtensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-msvideo': 'avi', 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
};
interface InspectedMedia { mediaType: string; size: number; width?: number; height?: number }

/** Detect the content, not the extension/HTTP MIME. Dimensions are header metadata, not proof that every frame decodes. */
export async function inspectMedia(bytes: Uint8Array, kind: MediaKind): Promise<InspectedMedia> {
  const prefix = Buffer.from(bytes.subarray(0, 64));
  const ascii = prefix.toString('latin1');
  let mediaType: string | undefined;
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mediaType = 'image/png';
  else if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) mediaType = 'image/jpeg';
  else if (/^GIF8[79]a/.test(ascii)) mediaType = 'image/gif';
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') mediaType = 'image/webp';
  else if (ascii.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii.slice(8))) mediaType = 'image/avif';
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') mediaType = 'audio/wav';
  else if (ascii.startsWith('fLaC')) mediaType = 'audio/flac';
  else if (ascii.startsWith('OggS')) mediaType = 'audio/ogg';
  else if (ascii.startsWith('ID3') || (prefix[0] === 255 && (prefix[1] & 0xe0) === 0xe0)) mediaType = 'audio/mpeg';
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') mediaType = 'video/x-msvideo';
  else if (prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) mediaType = 'video/webm';
  else if (ascii.slice(4, 8) === 'ftyp') mediaType = kind === 'audio' ? 'audio/mp4' : 'video/mp4';
  if (!mediaType || !mediaType.startsWith(`${kind}/`)) throw new AgentHttpError(422, '文件内容与素材类型不匹配或格式尚未支持');
  if (kind !== 'image') return { mediaType, size: bytes.byteLength };
  try {
    const dimensions = await sharp(bytes, { limitInputPixels: 65535 * 65535 }).metadata();
    const rotate = dimensions.orientation !== undefined && dimensions.orientation >= 5;
    const width = rotate ? dimensions.height : dimensions.width, height = rotate ? dimensions.width : dimensions.height;
    if (width === undefined || height === undefined || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('dimensions');
    return { mediaType, size: bytes.byteLength, width, height };
  } catch { throw new AgentHttpError(422, '无法读取图片尺寸，请检查图片文件'); }
}

export interface AssetServiceOptions { directory: string; serverId: string; maxImageBytes?: number; maxMediaBytes?: number; maxStorageBytes?: number }
/** Owns content-addressed durable blobs; ComfyUI input copies can be discarded and recreated from them. */
export class AssetService {
  private readonly captures = new Map<string, Promise<Asset>>();
  private readonly preparations = new Map<string, Promise<InputManifestEntry>>();
  private writing: Promise<void> = Promise.resolve();
  private readonly shutdown = new AbortController();
  constructor(readonly repository: WorkspaceRepository, readonly adapter: ComfyAdapter, readonly options: AssetServiceOptions) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  }
  busy(sessionId: string): boolean {
    return [...this.captures.keys()].some(id => this.repository.db.prepare('SELECT 1 FROM assets WHERE id=? AND session_id=?').get(id, sessionId))
      || [...this.preparations.keys()].some(key => (JSON.parse(key) as string[])[0] === sessionId);
  }
  /** Blob creation, reference publication and explicit cleanup share one process-local storage lock. */
  withStorageLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writing.then(work); this.writing = next.then(() => undefined, () => undefined); return next;
  }
  private maxBytes(kind: MediaKind) { return kind === 'image' ? this.options.maxImageBytes ?? 20 * 1024 * 1024 : this.options.maxMediaBytes ?? 200 * 1024 * 1024; }
  private blobPath(digest: string) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new AgentHttpError(422, '素材摘要不合法');
    return join(this.options.directory, `${digest}.blob`);
  }
  async stop() {
    this.shutdown.abort();
    await Promise.allSettled([...this.captures.values(), ...this.preparations.values(), this.writing]);
  }
  /** On process restart only: no GPU work is repeated when an interrupted download returns to pending. */
  recoverCaptures() {
    const rows = this.repository.db.prepare("SELECT data FROM assets WHERE capture_state='capturing'").all();
    for (const row of rows) { const asset = JSON.parse(String(row.data)) as Asset; this.repository.updateAsset(asset.sessionId, asset.id, { captureState: 'pending_capture' }); }
  }
  async capturePending() {
    await Promise.allSettled(this.repository.pendingAssets(2).map(asset => this.capture(asset.sessionId, asset.id)));
  }
  registerOutputs(sessionId: string, runId: string, raw: unknown) {
    return this.repository.transaction(() => {
      const run = this.repository.run(sessionId, runId);
      if (run.state !== 'succeeded') throw new AgentHttpError(409, '只有成功生成的输出可以登记为参考素材');
      const located = locateOutputs(raw);
      const ids: string[] = [];
      for (const output of located.outputs) {
        const id = randomUUID();
        const asset = this.repository.registerAsset({ id, sessionId, origin: 'generated', sourceRunId: runId, kind: output.kind,
          outputLocator: output.locator, name: output.filename, displayOrdinal: output.displayOrdinal,
          captureState: this.maxBytes(output.kind) ? 'pending_capture' : 'remote_only', metadata: {}, created: Date.now() },
        { id: randomUUID(), assetId: id, serverId: run.serverId, role: 'source', ref: { filename: output.filename, subfolder: output.subfolder, type: output.type } });
        ids.push(asset.id);
      }
      // Registration is idempotent by (run, locator), not by filename; preserve distinct batch outputs.
      return this.repository.updateRun(sessionId, runId, { outputAssetIds: ids, outputsIncomplete: located.incomplete, ...(located.incomplete ? { rawOutputs: raw } : {}) });
    });
  }
  registerUpload(sessionId: string, input: Attachment, requestId: string, sourceMessageSeq?: number): Asset {
    return this.repository.transaction(() => {
      this.repository.session(sessionId);
      const existing = this.repository.db.prepare('SELECT digest,asset_id FROM asset_upload_requests WHERE session_id=? AND request_id=?').get(sessionId, requestId);
      const identity = digest({ input, sourceMessageSeq });
      if (existing) {
        if (existing.digest !== identity) throw new AgentHttpError(409, '上传请求 ID 已用于另一素材');
        return this.repository.asset(sessionId, String(existing.asset_id));
      }
      if (sourceMessageSeq !== undefined && !this.repository.db.prepare("SELECT seq FROM events WHERE session_id=? AND seq=? AND kind='user'").get(sessionId, sourceMessageSeq)) throw new AgentHttpError(404, '上传素材引用的消息不存在');
      if (!input.filename || /[/\\]/.test(input.filename) || input.filename.includes('\0') || ['.', '..'].includes(input.filename) || (input.subfolder ?? '').split(/[/\\]/).includes('..') || !['input', 'temp'].includes(input.type)) throw new AgentHttpError(422, '上传素材路径不合法');
      const id = randomUUID();
      const asset = this.repository.registerAsset({ id, sessionId, kind: input.kind, origin: 'uploaded', name: input.name ?? input.filename,
        ...(sourceMessageSeq !== undefined ? { sourceMessageSeq } : {}), displayOrdinal: 1, captureState: input.kind === 'file' ? 'remote_only' : 'pending_capture',
        metadata: {}, created: Date.now() }, { id: randomUUID(), assetId: id, serverId: this.options.serverId, role: 'source', ref: { filename: input.filename, subfolder: input.subfolder ?? '', type: input.type } });
      this.repository.db.prepare('INSERT INTO asset_upload_requests VALUES(?,?,?,?)').run(sessionId, requestId, identity, id);
      return asset;
    });
  }
  capture(sessionId: string, assetId: string): Promise<Asset> {
    this.repository.asset(sessionId, assetId);
    const existing = this.captures.get(assetId);
    if (existing) return existing;
    const promise = this.captureOne(sessionId, assetId).finally(() => this.captures.delete(assetId));
    this.captures.set(assetId, promise);
    return promise;
  }
  private async captureOne(sessionId: string, assetId: string): Promise<Asset> {
    const asset = this.repository.asset(sessionId, assetId);
    if (asset.captureState === 'ready' && asset.blobDigest) {
      try { await this.readBlob(asset); return asset; } catch { /* Recover only bytes matching the original digest. */ }
    }
    if (asset.kind === 'file' || this.maxBytes(asset.kind) === 0) throw new AgentHttpError(422, '此素材目前仅支持远程预览');
    const signal = this.shutdown.signal;
    this.repository.updateAsset(sessionId, assetId, { captureState: 'capturing', error: undefined });
    try {
      signal.throwIfAborted();
      const locations = this.repository.locations(sessionId, assetId).filter(location => location.serverId === this.options.serverId);
      if (!locations.length) throw new AgentHttpError(422, '素材来自另一服务器，请重新关联原服务器');
      let bytes: Uint8Array | undefined, contentDigest: string | undefined;
      // Legacy source/copy locations are not proof of identical content. Compare all readable candidates before adopting bytes.
      for (const location of locations) {
        let file;
        try { file = await this.adapter.getFile(location.ref, signal, this.maxBytes(asset.kind)); }
        catch (error) { if (error instanceof ComfyRequestError && error.status === 404) continue; throw error; }
        const actual = hashBytes(file.bytes);
        if (asset.blobDigest && actual !== asset.blobDigest) continue;
        if (contentDigest && actual !== contentDigest) throw new AgentHttpError(409, '历史素材的源文件与副本内容不同，请明确选择原图');
        bytes = file.bytes; contentDigest = actual;
      }
      if (!bytes || !contentDigest) throw new AgentHttpError(404, asset.blobDigest ? '原素材已丢失或内容被替换，请重新提供原文件' : '素材文件已不存在，请重新生成或上传');
      const metadata = await inspectMedia(bytes, asset.kind);
      return await this.withStorageLock(async () => {
        await this.saveBlob(contentDigest!, bytes!, signal);
        signal.throwIfAborted();
        return this.repository.updateAsset(sessionId, assetId, { captureState: 'ready', blobDigest: contentDigest, metadata, captured: Date.now(), error: undefined });
      });
    } catch (error) {
      const status = error instanceof ComfyRequestError || error instanceof AgentHttpError ? error.status : 0;
      const message = error instanceof AgentHttpError ? error.message : status === 413 ? '素材文件超过收集大小上限' : signal.aborted ? '素材准备已暂停，将在下次启动恢复' : '素材文件收集失败，请重试';
      this.repository.updateAsset(sessionId, assetId, { captureState: signal.aborted ? 'pending_capture' : status === 404 ? 'missing' : status === 413 ? 'remote_only' : 'capture_failed', error: message });
      throw new AgentHttpError(status || 422, message);
    }
  }
  private async readBlob(asset: Asset): Promise<Uint8Array> {
    if (!asset.blobDigest) throw new AgentHttpError(404, '素材内容尚未准备完成');
    const path = this.blobPath(asset.blobDigest);
    if ((await stat(path)).size > this.maxBytes(asset.kind)) throw new AgentHttpError(413, '素材超过读取上限');
    const bytes = await readFile(path);
    if (hashBytes(bytes) !== asset.blobDigest) throw new AgentHttpError(422, '素材副本内容校验失败');
    return bytes;
  }
  async read(sessionId: string, assetId: string) {
    const asset = await this.capture(sessionId, assetId);
    return { asset, bytes: await this.readBlob(asset), mediaType: asset.metadata.mediaType! };
  }
  private async saveBlob(contentDigest: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const target = this.blobPath(contentDigest);
      try { if ((await stat(target)).size === bytes.byteLength && hashBytes(await readFile(target)) === contentDigest) return; } catch { /* Missing/corrupt managed copy is repaired from verified bytes. */ }
      let total = 0;
      for (const filename of await readdir(this.options.directory)) if (/^[0-9a-f]{64}\.blob$/.test(filename)) total += (await stat(join(this.options.directory, filename))).size;
      const replacingSize = await stat(target).then(value => value.size).catch(() => 0);
      if (total - replacingSize + bytes.byteLength > (this.options.maxStorageBytes ?? 5 * 1024 ** 3)) throw new AgentHttpError(507, '素材存储空间已达到上限，请清理不再需要的内容');
      const temporary = join(this.options.directory, `${contentDigest}-${randomUUID()}.part`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx', signal });
        signal.throwIfAborted();
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(() => undefined); }
  }
  materialize(sessionId: string, assetId: string, loaderKind: string, bindingId: string, signal: AbortSignal): Promise<InputManifestEntry> {
    const key = JSON.stringify([sessionId, assetId, loaderKind]);
    const existing = this.preparations.get(key);
    if (existing) return existing.then(result => ({ ...result, bindingId }));
    const promise = this.materializeOne(sessionId, assetId, loaderKind, bindingId, signal).finally(() => this.preparations.delete(key));
    this.preparations.set(key, promise);
    return promise;
  }
  private async materializeOne(sessionId: string, assetId: string, loaderKind: string, bindingId: string, signal: AbortSignal): Promise<InputManifestEntry> {
    const expected: Record<string, MediaKind> = { LoadImage: 'image', LoadAudio: 'audio', LoadVideo: 'video' };
    const asset = this.repository.asset(sessionId, assetId);
    if (!expected[loaderKind] || expected[loaderKind] !== asset.kind) throw new AgentHttpError(422, '素材与参考输入类型不匹配');
    const captured = await this.capture(sessionId, assetId);
    signal.throwIfAborted();
    const blobDigest = captured.blobDigest!;
    const serverId = this.options.serverId;
    const prior = this.repository.materialization(assetId, blobDigest, serverId, loaderKind);
    const record = { assetId, blobDigest, serverId, loaderKind, updated: Date.now() };
    try {
      if (prior?.ref) {
        try {
          const current = await this.adapter.getFile(prior.ref, signal, this.maxBytes(asset.kind));
          if (hashBytes(current.bytes) === blobDigest) return { bindingId, assetId, blobDigest, serverId, materializedRef: prior.ref };
        } catch (error) { if (!(error instanceof ComfyRequestError) || error.status !== 404) throw error; }
      }
      this.repository.putMaterialization({ ...record, state: 'preparing' });
      const bytes = await this.readBlob(captured);
      const extension = mimeExtensions[captured.metadata.mediaType!];
      if (!extension) throw new AgentHttpError(422, '此素材格式不能作为参考输入');
      const ref = await this.adapter.uploadImage({ bytes, mediaType: captured.metadata.mediaType! }, `agent-${assetId}-${blobDigest.slice(0, 16)}.${extension}`, '', signal);
      // Upload success is not evidence of the returned file's identity until it can be read back.
      const uploaded = await this.adapter.getFile(ref, signal, this.maxBytes(asset.kind));
      if (hashBytes(uploaded.bytes) !== blobDigest) throw new AgentHttpError(422, '参考输入内容校验失败');
      signal.throwIfAborted();
      this.repository.putMaterialization({ ...record, state: 'ready', ref });
      const location: AssetLocation = { id: randomUUID(), assetId, serverId, role: 'input', ref, verifiedDigest: blobDigest, verifiedAt: Date.now() };
      this.repository.putLocation(location);
      return { bindingId, assetId, blobDigest, serverId, materializedRef: ref };
    } catch (error) {
      this.repository.putMaterialization({ ...record, state: 'failed', error: error instanceof AgentHttpError ? error.message : '参考输入准备失败' });
      throw error;
    }
  }
}

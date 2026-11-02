import { Test } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PreconditionFailedException, NotFoundException, StorageService } from '@platform';
import type { JwtPayload } from '@platform';
import { AttachmentsService } from './attachments.service';
import { FILE_REPOSITORY } from '../domain/ports/file.repository';
import {
  ENTITY_ATTACHMENT_POLICY,
  USER_AVATAR_POLICY,
  WORKSPACE_LOGO_POLICY,
} from '../domain/attachment-policy';
import type { StoredFile } from '../domain/file.types';

const WORKSPACE = '11111111-1111-1111-1111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-2222-2222-222222222222';
const CHECKSUM = `${'A'.repeat(43)}=`;

const actor = { sub: 'user-1', workspaceId: WORKSPACE } as unknown as JwtPayload;

const storedFile = (o: Partial<StoredFile> = {}): StoredFile => ({
  id: 'file-1',
  workspaceId: WORKSPACE,
  storageKey: `work-item-attachment/${WORKSPACE}/file-1.txt`,
  filename: 'notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 100,
  checksumSha256: CHECKSUM,
  visibility: 'private',
  status: 'pending',
  uploadedBy: 'user-1',
  createdAt: new Date('2026-01-01'),
  confirmedAt: null,
  deletedAt: null,
  ...o,
});

describe('AttachmentsService', () => {
  let service: AttachmentsService;
  let fileRepo: {
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
  };
  let storage: {
    presignPut: ReturnType<typeof vi.fn>;
    presignGet: ReturnType<typeof vi.fn>;
    headObject: ReturnType<typeof vi.fn>;
    deleteObject: ReturnType<typeof vi.fn>;
    cdnUrl: ReturnType<typeof vi.fn>;
    downloadTtlSeconds: number;
  };

  beforeEach(async () => {
    fileRepo = {
      findById: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((i) => Promise.resolve(storedFile(i))),
      confirm: vi
        .fn()
        .mockImplementation((id) => Promise.resolve(storedFile({ id, status: 'completed' }))),
      softDelete: vi.fn().mockResolvedValue(undefined),
    };
    storage = {
      presignPut: vi.fn().mockResolvedValue({ uploadUrl: 'https://b/put', requiredHeaders: {} }),
      presignGet: vi.fn().mockResolvedValue('https://b/get'),
      headObject: vi.fn().mockResolvedValue({ contentLength: 100, checksumSha256: CHECKSUM }),
      deleteObject: vi.fn().mockResolvedValue(undefined),
      cdnUrl: vi.fn().mockReturnValue(null),
      downloadTtlSeconds: 900,
    };

    const mod = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: FILE_REPOSITORY, useValue: fileRepo },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = mod.get(AttachmentsService);
  });

  const presign = (over: Partial<Parameters<AttachmentsService['presign']>[2]> = {}, count = 0) =>
    service.presign(
      actor,
      ENTITY_ATTACHMENT_POLICY,
      {
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        checksumSha256: CHECKSUM,
        ...over,
      },
      count,
    );

  describe('presign', () => {
    it('rejects a MIME type outside the policy', async () => {
      await expect(presign({ mimeType: 'application/x-msdownload' })).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(fileRepo.create).not.toHaveBeenCalled();
    });

    it.each(['image/heic', 'image/heif'])(
      'accepts %s (iPhone photos) on an attachment surface',
      async (mimeType) => {
        await expect(presign({ mimeType, filename: 'IMG_0001.HEIC' })).resolves.toBeDefined();
        expect(fileRepo.create).toHaveBeenCalled();
      },
    );

    it('does NOT accept HEIC on the inline surfaces: browsers cannot render it', async () => {
      for (const policy of [USER_AVATAR_POLICY, WORKSPACE_LOGO_POLICY]) {
        await expect(
          service.presign(
            actor,
            policy,
            {
              filename: 'a.heic',
              mimeType: 'image/heic',
              sizeBytes: 100,
              checksumSha256: CHECKSUM,
            },
            0,
          ),
        ).rejects.toThrow(PreconditionFailedException);
      }
    });

    it('rejects SVG — it is active content and must never be storable', async () => {
      await expect(presign({ mimeType: 'image/svg+xml' })).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('rejects a file over the policy size limit', async () => {
      await expect(presign({ sizeBytes: 26 * 1024 * 1024 })).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('rejects a malformed checksum', async () => {
      await expect(presign({ checksumSha256: 'not-a-digest' })).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('enforces the per-owner quota', async () => {
      await expect(presign({}, 25)).rejects.toThrow(PreconditionFailedException);
    });

    // A presigned PUT cannot carry a checksum. Passing one made the client send
    // an x-amz-* header the signature did not cover; S3/R2 answered 403 without
    // CORS headers and the browser reported an opaque "Failed to fetch", so every
    // upload failed. Guard against it coming back.
    it('does NOT ask the storage layer to sign a checksum', async () => {
      await presign();
      expect(storage.presignPut).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: 'private', mimeType: 'text/plain' }),
      );
      expect(storage.presignPut.mock.calls[0][0]).not.toHaveProperty('checksumSha256');
    });

    it('still records the client checksum for dedup / later verification', async () => {
      await presign();
      expect(fileRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ checksumSha256: CHECKSUM }),
      );
    });

    it('namespaces the key by surface and workspace, never by client filename', async () => {
      await presign({ filename: '../../etc/passwd' });
      const key = fileRepo.create.mock.calls[0][0].storageKey as string;
      expect(key.startsWith(`work-item-attachment/${WORKSPACE}/`)).toBe(true);
      expect(key).not.toContain('..');
      expect(key).not.toContain('passwd');
    });

    it('drops an extension that is not a short alphanumeric token', async () => {
      await presign({ filename: 'evil.pn g/../x' });
      const key = fileRepo.create.mock.calls[0][0].storageKey as string;
      expect(key.endsWith(`/${key.split('/').pop()}`)).toBe(true);
      expect(key).not.toContain('/../');
    });
  });

  describe('confirm', () => {
    beforeEach(() => fileRepo.findById.mockResolvedValue(storedFile()));

    it('fails when the object never landed in the bucket', async () => {
      storage.headObject.mockResolvedValue(null);
      await expect(service.confirm(actor, 'file-1', ENTITY_ATTACHMENT_POLICY)).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('discards a file whose stored size differs from the declared size', async () => {
      storage.headObject.mockResolvedValue({ contentLength: 999, checksumSha256: CHECKSUM });
      await expect(service.confirm(actor, 'file-1', ENTITY_ATTACHMENT_POLICY)).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(fileRepo.softDelete).toHaveBeenCalledWith('file-1');
      expect(storage.deleteObject).toHaveBeenCalled();
    });

    it('discards a same-size file whose checksum differs — the substitution case', async () => {
      storage.headObject.mockResolvedValue({
        contentLength: 100,
        checksumSha256: `${'B'.repeat(43)}=`,
      });
      await expect(service.confirm(actor, 'file-1', ENTITY_ATTACHMENT_POLICY)).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(fileRepo.softDelete).toHaveBeenCalledWith('file-1');
    });

    it('cannot confirm a file belonging to another workspace', async () => {
      fileRepo.findById.mockResolvedValue(null);
      await expect(
        service.confirm(
          { ...actor, workspaceId: OTHER_WORKSPACE },
          'file-1',
          ENTITY_ATTACHMENT_POLICY,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('cannot re-confirm an already completed file', async () => {
      fileRepo.findById.mockResolvedValue(storedFile({ status: 'completed' }));
      await expect(service.confirm(actor, 'file-1', ENTITY_ATTACHMENT_POLICY)).rejects.toThrow(
        PreconditionFailedException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('forces Content-Disposition: attachment for private files', async () => {
      fileRepo.findById.mockResolvedValue(storedFile({ status: 'completed' }));
      await service.getDownloadUrl(actor, 'file-1', ENTITY_ATTACHMENT_POLICY);
      expect(storage.presignGet).toHaveBeenCalledWith(expect.objectContaining({ inline: false }));
    });

    it('never signs a URL for a file in another workspace', async () => {
      fileRepo.findById.mockResolvedValue(null);
      await expect(
        service.getDownloadUrl(actor, 'file-1', ENTITY_ATTACHMENT_POLICY),
      ).rejects.toThrow(NotFoundException);
      expect(storage.presignGet).not.toHaveBeenCalled();
    });

    it('serves public assets from the CDN without a signature', async () => {
      fileRepo.findById.mockResolvedValue(
        storedFile({ status: 'completed', visibility: 'public' }),
      );
      storage.cdnUrl.mockReturnValue('https://cdn.example.com/avatar.png');
      const { url } = await service.getDownloadUrl(actor, 'file-1', USER_AVATAR_POLICY);
      expect(url).toBe('https://cdn.example.com/avatar.png');
      expect(storage.presignGet).not.toHaveBeenCalled();
    });
  });
});

import { v2 as cloudinary } from 'cloudinary';
import { supabaseAdmin } from './supabase';

export function isCloudinaryConfigured(): boolean {
  const url = process.env.CLOUDINARY_URL || '';
  const apiKey = process.env.CLOUDINARY_API_KEY || '';
  if (url && !url.includes('your-cloudinary') && !url.includes('[YOUR-')) {
    return true;
  }
  if (
    apiKey &&
    !apiKey.includes('your-') &&
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    return true;
  }
  return false;
}

if (isCloudinaryConfigured()) {
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config({
      cloudinary_url: process.env.CLOUDINARY_URL,
    });
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
}

export { cloudinary };

export async function uploadBufferToCloudinary(
  buffer: Buffer,
  options: {
    folder?: string;
    resource_type?: 'auto' | 'image' | 'raw' | 'video';
    public_id?: string;
  } = {}
) {
  return new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || 'lms-assistant',
        resource_type: options.resource_type || 'auto',
        public_id: options.public_id,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Upload failed'));
        } else {
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
          });
        }
      }
    );
    uploadStream.end(buffer);
  });
}

/**
 * Upload a document or material to cloud storage.
 * Prioritizes Cloudinary when configured; otherwise stores in Supabase Storage `personal-materials`.
 */
export async function uploadMaterialFile(
  buffer: Buffer,
  filename: string,
  options: {
    folder?: string;
    contentType?: string;
  } = {}
): Promise<{ secure_url: string; storageProvider: 'cloudinary' | 'supabase' }> {
  // 1. Try Cloudinary if keys are valid
  if (isCloudinaryConfigured()) {
    try {
      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const res = await uploadBufferToCloudinary(buffer, {
        folder: options.folder || 'lms-assistant/materials',
        resource_type: 'auto',
        public_id: sanitizedFilename,
      });
      return { secure_url: res.secure_url, storageProvider: 'cloudinary' };
    } catch (err) {
      console.warn('Cloudinary upload error, attempting Supabase Storage fallback:', err);
    }
  }

  // 2. Fallback to Supabase Storage bucket 'personal-materials'
  const sanitizedFilename = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const filePath = options.folder ? `${options.folder}/${sanitizedFilename}` : sanitizedFilename;

  const { error: uploadError } = await supabaseAdmin.storage
    .from('personal-materials')
    .upload(filePath, buffer, {
      contentType: options.contentType || 'application/octet-stream',
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload to storage: ${uploadError.message}`);
  }

  const { data: publicUrlData } = supabaseAdmin.storage
    .from('personal-materials')
    .getPublicUrl(filePath);

  return {
    secure_url: publicUrlData.publicUrl,
    storageProvider: 'supabase',
  };
}

export async function deleteMaterialFile(storageUrl: string): Promise<void> {
  if (!storageUrl || storageUrl.startsWith('https://local.storage/')) return;

  if (storageUrl.includes('res.cloudinary.com') && isCloudinaryConfigured()) {
    const marker = '/upload/';
    const markerIndex = storageUrl.indexOf(marker);
    if (markerIndex >= 0) {
      const withoutVersion = decodeURIComponent(
        storageUrl.slice(markerIndex + marker.length).replace(/^v\d+\//, '')
      );
      const resourceType = storageUrl.includes('/image/upload/')
        ? 'image'
        : storageUrl.includes('/video/upload/')
          ? 'video'
          : 'raw';
      const publicId = resourceType === 'raw' ? withoutVersion : withoutVersion.replace(/\.[^/.]+$/, '');
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        invalidate: true,
      });
      if (result.result !== 'ok' && result.result !== 'not found') {
        throw new Error(`Cloudinary deletion failed: ${result.result}`);
      }
    }
    return;
  }

  if (supabaseAdmin) {
    const marker = '/storage/v1/object/public/personal-materials/';
    const markerIndex = storageUrl.indexOf(marker);
    if (markerIndex >= 0) {
      const path = decodeURIComponent(storageUrl.slice(markerIndex + marker.length));
      const { error } = await supabaseAdmin.storage.from('personal-materials').remove([path]);
      if (error) throw error;
    }
  }
}



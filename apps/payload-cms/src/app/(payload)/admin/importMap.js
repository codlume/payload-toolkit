import { BlurHashPreview as BlurHashPreview_4ba5545a6d8b60d48f901125fa998fb8 } from '@codlume/payload-blurhash/client'
import { PreviewBridgeAdmin as PreviewBridgeAdmin_eb79a481456b70ae4ae9dd2a53470d9b } from '@codlume/payload-live-preview/client'
import { S3ClientUploadHandler as S3ClientUploadHandler_f97aa6c64367fa259c5bc0567239ef24 } from '@payloadcms/storage-s3/client'
import { CollectionCards as CollectionCards_f9c02e79a4aed9a3924487c0cd4cafb1 } from '@payloadcms/next/rsc'

/** @type import('payload').ImportMap */
export const importMap = {
  "@codlume/payload-blurhash/client#BlurHashPreview": BlurHashPreview_4ba5545a6d8b60d48f901125fa998fb8,
  "@codlume/payload-live-preview/client#PreviewBridgeAdmin": PreviewBridgeAdmin_eb79a481456b70ae4ae9dd2a53470d9b,
  "@payloadcms/storage-s3/client#S3ClientUploadHandler": S3ClientUploadHandler_f97aa6c64367fa259c5bc0567239ef24,
  "@payloadcms/next/rsc#CollectionCards": CollectionCards_f9c02e79a4aed9a3924487c0cd4cafb1
}
